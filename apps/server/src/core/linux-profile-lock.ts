import { createHash, randomBytes } from 'node:crypto';
import { constants as fileConstants } from 'node:fs';
import { link, lstat, open, readdir, readFile, readlink, rm } from 'node:fs/promises';
import type { Server } from 'node:net';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { CaxriError } from '@caxri/protocol';

import { fileSystemCode } from './private-json-store';

export type LockHandle = Awaited<ReturnType<typeof open>>;

/**
 * An exclusive profile lock: the open lock file carrying owner metadata, plus whatever kernel object enforces
 * exclusivity on this platform.
 */
export interface ProcessLock {
    handle: LockHandle;
    close: () => Promise<void>;
}

/**
 * How many derived lock names a start may walk past before giving up. Each squatted name is one the squatter observed
 * in `/proc/net/unix` while an earlier Server held it, so this bounds a sustained attack, not ordinary use.
 */
export const MAX_LOCK_NAMES = 64;

const SKIPPED_PROCESS_CODES = new Set(['ENOENT', 'EACCES', 'EPERM']);
const SECRET_PATTERN = /^[\da-f]{64}$/u;

/**
 * The `/proc` reads that tell a squatted lock name apart from one this account's own Server holds. Injected so the walk
 * can be tested on any platform.
 */
interface LinuxLockProbe {
    /**
     * Abstract socket names (without the leading NUL) mapped to every inode listed under them.
     */
    abstractSockets(): Promise<Map<string, string[]>>;
    /**
     * Inodes of every socket held open by a process running as this account.
     */
    ownSocketInodes(): Promise<Set<string>>;
}

/**
 * Reported once per start that met a squatted name: `acquired` after skipping past it, `exhausted` when every name in
 * the series was held by another account.
 */
export interface LockSquatReport {
    outcome: 'acquired' | 'exhausted';
    squattedNames: number;
}

export interface LinuxLockOptions {
    bind?: (name: string) => Promise<Server>;
    onSquatted?: (report: LockSquatReport) => void;
    probe?: LinuxLockProbe;
    uid?: number;
}

/**
 * Linux has no open-time lock flag and Node exposes no `flock`, so exclusivity comes from binding an abstract-namespace
 * Unix socket. The kernel owns the name: a second bind fails with EADDRINUSE, and the name disappears the instant the
 * owner exits, including on SIGKILL, so a crashed Host never leaves a stale lock behind. Abstract names carry no file
 * permissions, though, and `/proc/net/unix` shows them to every account, so on a shared machine another user could bind
 * a predictable name first and keep this account's Server from ever starting (#1907). Names are therefore derived from
 * a secret only this account can read, and a name another account holds is skipped for the next one in the series.
 * Exclusivity between this account's own Servers never depends on a name being free: whenever a holder cannot be shown
 * to belong to another account, the start fails as a conflict, as it did before.
 */
export async function acquireLinuxProcessLock(
    path: string,
    options: LinuxLockOptions = {},
): Promise<ProcessLock> {
    const uid = options.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
    const bind = options.bind ?? bindAbstractSocket;
    const probe = options.probe ?? procLockProbe(uid);
    const secret = await readOrCreateSecret(join(dirname(path), 'lock-secret'));
    const names = lockNames(secret, uid);
    const { server, squattedNames } = await claimName(names, bind, probe, options.onSquatted);
    try {
        await refuseSecondOwnHolder(names, server.name, probe);
        if (squattedNames > 0) options.onSquatted?.({ outcome: 'acquired', squattedNames });
        const handle = await open(
            path,
            fileConstants.O_RDWR | fileConstants.O_CREAT | fileConstants.O_NOFOLLOW,
            0o600,
        );
        return {
            handle,
            close: async () => {
                try {
                    await handle.close();
                } finally {
                    await closeServer(server.server);
                }
            },
        };
    } catch (error) {
        await closeServer(server.server);
        throw error;
    }
}

function lockNames(secret: string, uid: number): string[] {
    return Array.from(
        { length: MAX_LOCK_NAMES },
        (_, index) =>
            `caxri-profile-${uid}-${createHash('sha256').update(`${secret}:${index}`).digest('hex').slice(0, 32)}`,
    );
}

async function claimName(
    names: readonly string[],
    bind: (name: string) => Promise<Server>,
    probe: LinuxLockProbe,
    onSquatted: LinuxLockOptions['onSquatted'],
): Promise<{ server: { name: string; server: Server }; squattedNames: number }> {
    let squattedNames = 0;
    for (const name of names) {
        try {
            // eslint-disable-next-line no-await-in-loop -- names are claimed in order so every own Server walks the same series
            return { server: { name, server: await bind(`\0${name}`) }, squattedNames };
        } catch (error) {
            if (fileSystemCode(error) !== 'EADDRINUSE') throw error;
        }
        // eslint-disable-next-line no-await-in-loop -- the holder must be identified before deciding to move on
        if ((await holderOf(name, probe)) !== 'other') throw ownerConflict();
        squattedNames += 1;
    }
    onSquatted?.({ outcome: 'exhausted', squattedNames });
    throw new CaxriError(
        'CONFLICT',
        'Other accounts on this machine hold every Host profile lock name',
    );
}

/**
 * A name held by an inode no process of this account owns belongs to another account. A holder that already exited, or
 * `/proc` that cannot be read (hidepid, sandboxed kernels), stays a conflict: guessing "squatted" there could let two
 * of this account's Servers own one profile.
 */
async function holderOf(name: string, probe: LinuxLockProbe): Promise<'own' | 'other' | 'unknown'> {
    try {
        const inodes = (await probe.abstractSockets()).get(name);
        if (!inodes) return 'unknown';
        const own = await probe.ownSocketInodes();
        return inodes.some((inode) => own.has(inode)) ? 'own' : 'other';
    } catch {
        return 'unknown';
    }
}

/**
 * Two own Servers can end up on different names: one skipped a squatted name, the squatter then released it, and a
 * later start claimed the lower name. A start that finds another of this account's names held by its own process
 * yields, before it serves anything.
 */
async function refuseSecondOwnHolder(
    names: readonly string[],
    claimed: string,
    probe: LinuxLockProbe,
): Promise<void> {
    let sockets: Map<string, string[]>;
    try {
        sockets = await probe.abstractSockets();
    } catch {
        throw ownerConflict();
    }
    const others = names.filter((name) => name !== claimed && sockets.has(name));
    if (others.length === 0) return;
    let own: Set<string>;
    try {
        own = await probe.ownSocketInodes();
    } catch {
        throw ownerConflict();
    }
    if (others.some((name) => sockets.get(name)!.some((inode) => own.has(inode))))
        throw ownerConflict();
}

function ownerConflict(): CaxriError {
    return new CaxriError('CONFLICT', 'A Host already owns this profile');
}

/**
 * Publishes the secret with `link`, which fails when the name exists, so a concurrent first start either wins with a
 * fully written file or reads the winner's.
 */
async function readOrCreateSecret(path: string): Promise<string> {
    try {
        return await readSecret(path);
    } catch (error) {
        if (fileSystemCode(error) !== 'ENOENT') throw error;
    }
    const temporary = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
    const handle = await open(
        temporary,
        fileConstants.O_WRONLY |
            fileConstants.O_CREAT |
            fileConstants.O_EXCL |
            fileConstants.O_NOFOLLOW,
        0o600,
    );
    try {
        await handle.writeFile(randomBytes(32).toString('hex'));
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await link(temporary, path);
    } catch (error) {
        if (fileSystemCode(error) !== 'EEXIST') throw error;
    } finally {
        await rm(temporary, { force: true });
    }
    return readSecret(path);
}

async function readSecret(path: string): Promise<string> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
        throw new CaxriError('PATH_DENIED', 'Host lock secret is not private');
    const secret = (await readFile(path, 'utf8')).trim();
    if (!SECRET_PATTERN.test(secret))
        throw new CaxriError(
            'VALIDATION',
            'Host lock secret is malformed; delete it only after verifying no Host is running',
        );
    return secret;
}

/**
 * Reads `/proc/net/unix` (`Num RefCount Protocol Flags Type St Inode Path`, abstract names printed with a leading `@`).
 * The kernel prints a name's bytes verbatim, so another account can bind a name containing spaces or a newline to forge
 * a row naming this account's lock with its own inode. Rows that do not have exactly eight columns are dropped, and
 * every inode listed under a name is kept: a forged row can add a holder but never hide the real one, and the caller
 * treats a name as this account's when any of its inodes is.
 */
export function parseAbstractSockets(table: string): Map<string, string[]> {
    const sockets = new Map<string, string[]>();
    for (const line of table.split('\n').slice(1)) {
        const columns = line.trim().split(/\s+/u);
        if (columns.length !== 8 || !columns[7].startsWith('@')) continue;
        const name = columns[7].slice(1);
        sockets.set(name, [...(sockets.get(name) ?? []), columns[6]]);
    }
    return sockets;
}

function procLockProbe(uid: number): LinuxLockProbe {
    return {
        abstractSockets: async () => parseAbstractSockets(await readFile('/proc/net/unix', 'utf8')),
        async ownSocketInodes() {
            const inodes = new Set<string>();
            const entries = await readdir('/proc');
            for (const pid of entries) {
                if (!/^\d+$/u.test(pid)) continue;
                let descriptors: string[];
                try {
                    // eslint-disable-next-line no-await-in-loop -- bounded by this account's processes; runs only on a contested name
                    if ((await lstat(`/proc/${pid}`)).uid !== uid) continue;
                    // eslint-disable-next-line no-await-in-loop -- see above
                    descriptors = await readdir(`/proc/${pid}/fd`);
                } catch (error) {
                    // An exited process cannot hold the name. Neither can an own process that hides its descriptors:
                    // the kernel does that only for non-dumpable processes (the account's own `sshd` session,
                    // setuid helpers), and a Caxri Server never makes itself non-dumpable.
                    if (SKIPPED_PROCESS_CODES.has(fileSystemCode(error) ?? '')) continue;
                    throw error;
                }
                for (const fd of descriptors) {
                    // eslint-disable-next-line no-await-in-loop -- see above
                    const inode = await socketInode(`/proc/${pid}/fd/${fd}`);
                    if (inode) inodes.add(inode);
                }
            }
            return inodes;
        },
    };
}

async function socketInode(descriptor: string): Promise<string | undefined> {
    try {
        return /^socket:\[(\d+)\]$/u.exec(await readlink(descriptor))?.[1];
    } catch {
        // The descriptor closed between listing and reading; it holds nothing now.
        return undefined;
    }
}

function bindAbstractSocket(name: string): Promise<Server> {
    return new Promise((resolve, reject) => {
        // Nothing legitimate connects to the lock socket; drop any connection immediately.
        const server = createServer((socket) => socket.destroy());
        server.once('error', reject);
        server.listen({ path: name, exclusive: true }, () => {
            // The lock must not hold the event loop open past the Host's own shutdown.
            server.unref();
            resolve(server);
        });
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve) => {
        server.close(() => resolve());
    });
}
