import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CommandError, getProcessIdentity, isProcessIdentityAlive } from './process';
import {
    ensureProfile,
    errorCode,
    repositoryContext,
    unlinkIfExists,
    withRepositoryLock,
    worktreeIdentity,
    writeJsonAtomic,
} from './repository';

interface DesktopLease {
    acquiredAt: string;
    identity: string;
    label: string;
    pid: number;
    token: string;
    worktreeId: string;
    worktreePath: string;
}

export interface DesktopLeaseHandle extends DesktopLease {
    leasePath: string;
}

export interface DesktopLeaseOptions {
    /** Test seam for holding the repository lock across a competing acquisition. */
    afterLockAcquired?: () => Promise<void>;
}

export type DesktopLeaseStatus =
    { lease?: undefined; state: 'free' } | { lease: DesktopLease; state: 'active' | 'stale' };

function parseLease(value: string, path: string): DesktopLease {
    let lease: unknown;
    try {
        lease = JSON.parse(value);
    } catch {
        throw new CommandError(`Invalid desktop lease at ${path}; inspect it before continuing`);
    }
    const candidate = lease as Partial<DesktopLease>;
    if (
        typeof candidate.acquiredAt !== 'string' ||
        typeof candidate.identity !== 'string' ||
        typeof candidate.label !== 'string' ||
        typeof candidate.pid !== 'number' ||
        typeof candidate.token !== 'string' ||
        typeof candidate.worktreeId !== 'string' ||
        typeof candidate.worktreePath !== 'string'
    ) {
        throw new CommandError(`Invalid desktop lease at ${path}; inspect it before continuing`);
    }
    return candidate as DesktopLease;
}

async function readLease(path: string): Promise<DesktopLease | undefined> {
    try {
        return parseLease(await readFile(path, 'utf8'), path);
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
    }
}

export async function inspectDesktopLease(cwd: string): Promise<DesktopLeaseStatus> {
    const context = await repositoryContext(cwd);
    const lease = await readLease(join(context.stateDir, 'desktop-lease.json'));
    if (!lease) return { state: 'free' };
    return {
        lease,
        state: (await isProcessIdentityAlive(lease.pid, lease.identity)) ? 'active' : 'stale',
    };
}

/** Acquire the repository-wide macOS desktop surface before starting Electron. */
export async function acquireDesktopLease(
    cwd: string,
    label: string,
    ownerPid = process.pid,
    options: DesktopLeaseOptions = {},
): Promise<DesktopLeaseHandle> {
    const context = await repositoryContext(cwd);
    const worktreeId = await worktreeIdentity(context.root, true);
    const identity = await getProcessIdentity(ownerPid);
    if (!worktreeId || !identity)
        throw new CommandError('Could not establish the desktop lease owner identity');
    await ensureProfile(context, worktreeId);
    const leasePath = join(context.stateDir, 'desktop-lease.json');
    await mkdir(context.stateDir, { recursive: true });
    const lease: DesktopLease = {
        acquiredAt: new Date().toISOString(),
        identity,
        label,
        pid: ownerPid,
        token: randomUUID(),
        worktreeId,
        worktreePath: context.root,
    };

    return await withRepositoryLock(context, async () => {
        await options.afterLockAcquired?.();
        for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
                const handle = await open(leasePath, 'wx');
                try {
                    await handle.writeFile(`${JSON.stringify(lease, null, 2)}\n`, 'utf8');
                    await handle.sync();
                } finally {
                    await handle.close();
                }
                return { ...lease, leasePath };
            } catch (error) {
                if (errorCode(error) !== 'EEXIST') throw error;
                const current = await readLease(leasePath);
                if (!current) continue;
                if (await isProcessIdentityAlive(current.pid, current.identity)) {
                    throw new CommandError(
                        `Desktop is in use by ${current.label} in ${current.worktreePath} (PID ${current.pid})`,
                    );
                }
                /** The repository lock keeps another contender from replacing this stale path
                 *  between the identity check and unlink. */
                await unlinkIfExists(leasePath);
            }
        }
        throw new CommandError('Could not acquire the repository desktop lease');
    });
}

/** Transfer ownership after Electron starts so a surviving app keeps the lease fail-closed. */
export async function transferDesktopLease(
    handle: DesktopLeaseHandle,
    ownerPid: number,
): Promise<DesktopLeaseHandle> {
    const current = await readLease(handle.leasePath);
    if (!current || current.token !== handle.token) {
        throw new CommandError('Desktop lease ownership changed before transfer');
    }
    const identity = await getProcessIdentity(ownerPid);
    if (!identity) throw new CommandError(`Could not establish Electron PID ${ownerPid} identity`);
    const transferred = { ...current, identity, pid: ownerPid };
    await writeJsonAtomic(handle.leasePath, transferred);
    return { ...transferred, leasePath: handle.leasePath };
}

export async function releaseDesktopLease(handle: DesktopLeaseHandle): Promise<void> {
    const current = await readLease(handle.leasePath);
    if (!current) return;
    if (current.token !== handle.token) {
        throw new CommandError('Refusing to release a desktop lease owned by another process');
    }
    await unlinkIfExists(handle.leasePath);
}
