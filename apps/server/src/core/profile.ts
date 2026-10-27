import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { constants as fileConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type {
    ServerControlEndpoint,
    ServerDesktopCredential,
    ServerLock,
    ServerManifest,
    ServerManifestIdentity,
} from '@caxri/protocol';
import {
    CAXRI_PROTOCOL_VERSION,
    CaxriError,
    SERVER_DESKTOP_CREDENTIAL_VERSION,
    SERVER_MANIFEST_VERSION,
    serverDesktopCredentialSchema,
    serverLockSchema,
    serverManifestSchema,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, profileIdForPath } from '@caxri/system';

import type { LockHandle, ProcessLock } from './linux-profile-lock';
import { acquireLinuxProcessLock } from './linux-profile-lock';
import { fileSystemCode, readPrivateJsonFile, replacePrivateJsonFile } from './private-json-store';
import type { HostLease } from './profile-host-lease';
import { claimHostLease, readHostIdentity } from './profile-host-lease';

const MAX_PRIVATE_FILE_BYTES = 16 * 1024;
/**
 * Darwin supports atomic open-time advisory locking, but Node omits this flag from `fs.constants`.
 */
const DARWIN_OPEN_EXCLUSIVE_LOCK = 0x20;

export interface ServerProfilePaths {
    desktopCredential: string;
    directory: string;
    /**
     * Cross-host lease for a profile on a shared home directory; see `profile-host-lease.ts`.
     */
    hostLease: string;
    lock: string;
    manifest: string;
    profileId: string;
    userDataPath: string;
}

export interface ServerProfileLease {
    desktopCredential: ServerDesktopCredential;
    identity: ServerManifestIdentity;
    /**
     * Available only after `publish()` has atomically committed the listening endpoint.
     */
    readonly manifest: ServerManifest;
    paths: ServerProfilePaths;
    publish(endpoint: ServerControlEndpoint): Promise<ServerManifest>;
    release(): Promise<void>;
}

export type ServerProcessState = 'alive' | 'dead' | 'unknown';

async function privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new CaxriError('PATH_DENIED', 'Host profile directory must be a real directory');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        throw new CaxriError('PATH_DENIED', 'Host profile directory belongs to another user');
    await chmod(path, 0o700);
}

export async function resolveServerProfilePaths(userDataPath: string): Promise<ServerProfilePaths> {
    await mkdir(userDataPath, { recursive: true });
    const canonicalUserDataPath = await realpath(userDataPath);
    const profileId = profileIdForPath(canonicalUserDataPath);
    const directory = join(canonicalUserDataPath, 'host');
    return {
        desktopCredential: join(directory, 'desktop-credential.json'),
        directory,
        hostLease: join(directory, 'host-lease.json'),
        lock: join(directory, 'owner.lock'),
        manifest: join(directory, 'manifest.json'),
        profileId,
        userDataPath: canonicalUserDataPath,
    };
}

async function readPrivateJson(path: string): Promise<unknown> {
    return readPrivateJsonFile({
        path,
        maxBytes: MAX_PRIVATE_FILE_BYTES,
        messages: {
            malformed:
                'Host profile metadata is malformed; repair it only after verifying no Host is running',
            notPrivate: 'Host profile metadata is not private',
            oversized: 'Host profile metadata is oversized',
            wrongOwner: 'Host profile metadata belongs to another user',
        },
    });
}

export async function readServerManifest(path: string): Promise<ServerManifest> {
    const parsed = serverManifestSchema.safeParse(await readPrivateJson(path));
    if (!parsed.success)
        throw new CaxriError(
            'VALIDATION',
            'Host manifest is invalid; repair it only after verifying no Host is running',
        );
    return parsed.data;
}

async function acquireProcessLock(
    path: string,
    logger: StructuredLogger | undefined,
): Promise<ProcessLock> {
    if (process.platform === 'darwin') {
        const handle = await acquireDarwinProcessLock(path);
        return { handle, close: () => handle.close() };
    }
    if (process.platform === 'linux')
        return acquireLinuxProcessLock(path, {
            onSquatted: ({ outcome, squattedNames }) =>
                logger?.write(
                    outcome === 'exhausted' ? 'error' : 'warn',
                    logEventCatalog.serverCore.profileLockSquatted,
                    { fields: { outcome, squattedNames } },
                ),
        });
    throw new CaxriError('UNAVAILABLE', 'Headless Host locking requires macOS or Linux');
}

async function acquireDarwinProcessLock(path: string): Promise<LockHandle> {
    const flags =
        fileConstants.O_RDWR |
        fileConstants.O_NONBLOCK |
        fileConstants.O_NOFOLLOW |
        DARWIN_OPEN_EXCLUSIVE_LOCK;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            // Each attempt must observe whether the exclusive create failed with EEXIST before
            // deciding whether to retry against the existing file, so these opens cannot be
            // parallelized across attempts.
            // eslint-disable-next-line no-await-in-loop -- sequential CAS retry, see comment above
            return await open(path, flags | fileConstants.O_CREAT | fileConstants.O_EXCL, 0o600);
        } catch (error) {
            if (fileSystemCode(error) !== 'EEXIST') throw error;
        }
        try {
            // eslint-disable-next-line no-await-in-loop -- sequential CAS retry, see comment above
            return await open(path, flags, 0o600);
        } catch (error) {
            const code = fileSystemCode(error);
            if (code === 'EAGAIN' || code === 'EWOULDBLOCK')
                throw new CaxriError('CONFLICT', 'A Host already owns this profile');
            if (code !== 'ENOENT') throw error;
        }
    }
    throw new CaxriError('CONFLICT', 'Another Host won the profile startup race');
}

async function readLockHandle(handle: LockHandle): Promise<ServerLock | undefined> {
    const metadata = await handle.stat();
    if (!metadata.isFile() || (metadata.mode & 0o077) !== 0)
        throw new CaxriError('PATH_DENIED', 'Host lock metadata is not private');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        throw new CaxriError('PATH_DENIED', 'Host lock metadata belongs to another user');
    if (metadata.size === 0) return undefined;
    if (metadata.size > MAX_PRIVATE_FILE_BYTES)
        throw new CaxriError('VALIDATION', 'Host lock metadata is oversized');
    const buffer = Buffer.alloc(metadata.size);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    let source: unknown;
    try {
        source = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as unknown;
    } catch {
        throw new CaxriError(
            'VALIDATION',
            'Host lock is malformed; repair it only after verifying no Host is running',
        );
    }
    const parsed = serverLockSchema.safeParse(source);
    if (!parsed.success)
        throw new CaxriError(
            'VALIDATION',
            'Host lock is invalid; repair it only after verifying no Host is running',
        );
    return parsed.data;
}

async function writeLockHandle(handle: LockHandle, value: ServerLock | undefined): Promise<void> {
    const source = value ? Buffer.from(`${JSON.stringify(value)}\n`, 'utf8') : Buffer.alloc(0);
    await handle.truncate(0);
    if (source.length > 0) await handle.write(source, 0, source.length, 0);
    await handle.truncate(source.length);
    await handle.sync();
}

async function replacePrivateJson(directory: string, path: string, value: unknown): Promise<void> {
    await replacePrivateJsonFile({ directory, path, temporaryPrefix: '.manifest-', value });
}

function probeServerProcess(pid: number): ServerProcessState {
    try {
        process.kill(pid, 0);
        return 'alive';
    } catch (error) {
        const code = fileSystemCode(error);
        if (code === 'ESRCH') return 'dead';
        if (code === 'EPERM') return 'alive';
        return 'unknown';
    }
}

async function optionalPrivateJson<T>(read: (path: string) => Promise<T>, path: string) {
    try {
        return await read(path);
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT') return;
        throw error;
    }
}

function assertSameProfile(paths: ServerProfilePaths, value: ServerLock | ServerManifest): void {
    if (value.profileId !== paths.profileId)
        throw new CaxriError(
            'VALIDATION',
            'Host profile metadata is inconsistent; remove it only after verifying no Host is running',
        );
}

async function cleanPreviousOwner(
    paths: ServerProfilePaths,
    previousLock: ServerLock | undefined,
    processState: (pid: number) => ServerProcessState,
): Promise<void> {
    const previousManifest = await optionalPrivateJson(readServerManifest, paths.manifest);
    if (!previousLock && !previousManifest) return;
    if (previousLock) assertSameProfile(paths, previousLock);
    if (previousManifest) {
        assertSameProfile(paths, previousManifest);
        if (
            previousLock &&
            (previousManifest.processIdentity !== previousLock.processIdentity ||
                previousManifest.pid !== previousLock.pid)
        )
            throw new CaxriError(
                'VALIDATION',
                'Host lock and manifest identities differ; repair the profile metadata manually',
            );
    }
    const previousOwner = previousLock ?? previousManifest!;
    const state = processState(previousOwner.pid);
    if (state !== 'dead')
        throw new CaxriError(
            'CONFLICT',
            state === 'alive'
                ? 'A Host already owns this profile'
                : 'The previous Host identity cannot be verified; repair is required',
        );
    if (previousManifest) await rm(paths.manifest, { force: true });
    await rm(paths.desktopCredential, { force: true });
}

async function isManifestOwnedBy(path: string, processIdentity: string) {
    try {
        const value = await readServerManifest(path);
        return value.processIdentity === processIdentity;
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT') return false;
        throw error;
    }
}

function stopAfterHostLeaseLost(holder: string): void {
    process.stderr.write(`Another host (${holder}) took over this profile; stopping.\n`);
    process.kill(process.pid, 'SIGTERM');
}

/**
 * Acquires the profile before domain startup, preventing a second SQLite writer from spawning.
 */
export async function acquireServerProfile(options: {
    /**
     * Called when another host took over this profile's lease while this Server ran. Defaults to stopping the process
     * through its ordinary SIGTERM shutdown.
     */
    onHostLeaseLost?: (holder: string) => void;
    /**
     * Records lock names another account held on a shared Linux machine; see `linux-profile-lock.ts`.
     */
    logger?: StructuredLogger;
    processState?: (pid: number) => ServerProcessState;
    startedAt?: number;
    userDataPath: string;
    version: string;
}): Promise<ServerProfileLease> {
    const paths = await resolveServerProfilePaths(options.userDataPath);
    await privateDirectory(paths.directory);
    /**
     * The kernel lock makes both ordinary startup and stale takeover one atomic profile CAS.
     */
    const processLock = await acquireProcessLock(paths.lock, options.logger);
    const lockHandle = processLock.handle;
    const processIdentity = randomBytes(16).toString('hex');
    const startedAt = options.startedAt ?? Date.now();
    const lock = serverLockSchema.parse({
        pid: process.pid,
        startedAt,
        processIdentity,
        profileId: paths.profileId,
    });
    const processState = options.processState ?? probeServerProcess;
    let previousLock: ServerLock | undefined;
    try {
        previousLock = await readLockHandle(lockHandle);
    } catch (error) {
        await processLock.close();
        throw error;
    }

    let hostLease: HostLease | undefined;
    try {
        // Claimed before `cleanPreviousOwner`, whose pid probe cannot see another host and would delete a live
        // owner's manifest there.
        if (process.platform === 'linux')
            hostLease = await claimHostLease({
                directory: paths.directory,
                identity: await readHostIdentity(),
                onLost: options.onHostLeaseLost ?? stopAfterHostLeaseLost,
                path: paths.hostLease,
                processIdentity,
            });
        await cleanPreviousOwner(paths, previousLock, processState);
        await writeLockHandle(lockHandle, lock);
        await chmod(paths.lock, 0o600);
    } catch (error) {
        await hostLease?.release();
        await processLock.close();
        throw error;
    }

    const identity = {
        ...lock,
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        version: options.version,
        operatorToken: randomBytes(32).toString('hex'),
    } satisfies ServerManifestIdentity;
    const desktopCredential = serverDesktopCredentialSchema.parse({
        credentialVersion: SERVER_DESKTOP_CREDENTIAL_VERSION,
        profileId: paths.profileId,
        processIdentity,
        desktopToken: randomBytes(32).toString('hex'),
    });
    let isPublished = false;
    let isReleased = false;
    let publishedManifest: ServerManifest | undefined;
    return {
        desktopCredential,
        identity,
        get manifest() {
            if (!publishedManifest)
                throw new CaxriError('UNAVAILABLE', 'Host endpoint has not been published');
            return publishedManifest;
        },
        paths,
        async publish(endpoint) {
            if (isPublished) return publishedManifest!;
            const manifest = serverManifestSchema.parse({
                ...identity,
                manifestVersion: SERVER_MANIFEST_VERSION,
                endpoint,
            });
            await replacePrivateJson(paths.directory, paths.desktopCredential, desktopCredential);
            await replacePrivateJson(paths.directory, paths.manifest, manifest);
            publishedManifest = manifest;
            isPublished = true;
            return manifest;
        },
        async release() {
            if (isReleased) return;
            isReleased = true;
            try {
                if (await isManifestOwnedBy(paths.manifest, processIdentity))
                    await rm(paths.manifest, { force: true });
            } catch {
                /**
                 * A corrupted manifest must not prevent release of the authenticated live owner.
                 */
            }
            try {
                await rm(paths.desktopCredential, { force: true });
            } catch {
                // Best-effort cleanup; release() must still finish tearing down the lock below.
            }
            try {
                await hostLease?.release();
                await writeLockHandle(lockHandle, undefined);
            } finally {
                await processLock.close();
            }
        },
    };
}
