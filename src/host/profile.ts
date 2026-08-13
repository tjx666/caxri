import { createHash, randomBytes } from 'node:crypto';
import { constants as fileConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CAXRI_PROTOCOL_VERSION } from '../shared/ipc/version';
import {
    HOST_MANIFEST_VERSION,
    HOST_DESKTOP_CREDENTIAL_VERSION,
    hostDesktopCredentialSchema,
    hostLockSchema,
    hostManifestSchema,
    type HostDesktopCredential,
    type HostLock,
    type HostManifest,
} from '../shared/ipc/local-transport';
import { CaxriError } from '../shared/ipc/errors';

const MAX_PRIVATE_FILE_BYTES = 16 * 1024;
const MAX_UNIX_SOCKET_PATH_BYTES = 103;
/** Darwin supports atomic open-time advisory locking, but Node omits this flag from `fs.constants`. */
const DARWIN_OPEN_EXCLUSIVE_LOCK = 0x20;

export interface HostProfilePaths {
    desktopCredential: string;
    directory: string;
    endpoint: string;
    lock: string;
    manifest: string;
    profileId: string;
    userDataPath: string;
}

export interface HostProfileLease {
    desktopCredential: HostDesktopCredential;
    manifest: HostManifest;
    paths: HostProfilePaths;
    publish(): Promise<void>;
    release(): Promise<void>;
}

export type HostProcessState = 'alive' | 'dead' | 'unknown';

function fileSystemCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function profileIdFor(path: string): string {
    return createHash('sha256').update(path).digest('hex').slice(0, 24);
}

function defaultSocketDirectory(): string {
    return process.platform === 'darwin' ? '/private/tmp' : tmpdir();
}

async function privateDirectory(path: string): Promise<void> {
    await mkdir(path, { recursive: true, mode: 0o700 });
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink())
        throw new CaxriError('PATH_DENIED', 'Host profile directory must be a real directory');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        throw new CaxriError('PATH_DENIED', 'Host profile directory belongs to another user');
    await chmod(path, 0o700);
}

export async function resolveHostProfilePaths(
    userDataPath: string,
    socketDirectory = defaultSocketDirectory(),
): Promise<HostProfilePaths> {
    await mkdir(userDataPath, { recursive: true });
    const canonicalUserDataPath = await realpath(userDataPath);
    const profileId = profileIdFor(canonicalUserDataPath);
    const endpoint = join(socketDirectory, `caxri-host-${profileId}.sock`);
    if (Buffer.byteLength(endpoint, 'utf8') > MAX_UNIX_SOCKET_PATH_BYTES)
        throw new CaxriError('VALIDATION', 'Host Unix socket path exceeds the platform limit');
    const directory = join(canonicalUserDataPath, 'host');
    return {
        desktopCredential: join(directory, 'desktop-credential.json'),
        directory,
        endpoint,
        lock: join(directory, 'owner.lock'),
        manifest: join(directory, 'manifest.json'),
        profileId,
        userDataPath: canonicalUserDataPath,
    };
}

async function readPrivateJson(path: string): Promise<unknown> {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0)
        throw new CaxriError('PATH_DENIED', 'Host profile metadata is not private');
    if (typeof process.getuid === 'function' && metadata.uid !== process.getuid())
        throw new CaxriError('PATH_DENIED', 'Host profile metadata belongs to another user');
    if (metadata.size > MAX_PRIVATE_FILE_BYTES)
        throw new CaxriError('VALIDATION', 'Host profile metadata is oversized');
    try {
        return JSON.parse(await readFile(path, 'utf8')) as unknown;
    } catch {
        throw new CaxriError(
            'VALIDATION',
            'Host profile metadata is malformed; repair it only after verifying no Host is running',
        );
    }
}

export async function readHostManifest(path: string): Promise<HostManifest> {
    const parsed = hostManifestSchema.safeParse(await readPrivateJson(path));
    if (!parsed.success)
        throw new CaxriError(
            'VALIDATION',
            'Host manifest is invalid; repair it only after verifying no Host is running',
        );
    return parsed.data;
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
    const handle = await open(path, 'wx', 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
        await handle.sync();
    } finally {
        await handle.close();
    }
}

async function acquireProcessLock(path: string) {
    if (process.platform !== 'darwin')
        throw new CaxriError('UNAVAILABLE', 'Headless Host locking requires macOS');
    const flags =
        fileConstants.O_RDWR |
        fileConstants.O_NONBLOCK |
        fileConstants.O_NOFOLLOW |
        DARWIN_OPEN_EXCLUSIVE_LOCK;
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            return await open(path, flags | fileConstants.O_CREAT | fileConstants.O_EXCL, 0o600);
        } catch (error) {
            if (fileSystemCode(error) !== 'EEXIST') throw error;
        }
        try {
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

async function readLockHandle(
    handle: Awaited<ReturnType<typeof open>>,
): Promise<HostLock | undefined> {
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
    const parsed = hostLockSchema.safeParse(source);
    if (!parsed.success)
        throw new CaxriError(
            'VALIDATION',
            'Host lock is invalid; repair it only after verifying no Host is running',
        );
    return parsed.data;
}

async function writeLockHandle(
    handle: Awaited<ReturnType<typeof open>>,
    value: HostLock | undefined,
): Promise<void> {
    const source = value ? Buffer.from(`${JSON.stringify(value)}\n`, 'utf8') : Buffer.alloc(0);
    await handle.truncate(0);
    if (source.length > 0) await handle.write(source, 0, source.length, 0);
    await handle.truncate(source.length);
    await handle.sync();
}

async function replacePrivateJson(directory: string, path: string, value: unknown): Promise<void> {
    const temporary = join(directory, `.manifest-${randomBytes(12).toString('hex')}.tmp`);
    try {
        await writePrivateJson(temporary, value);
        await rename(temporary, path);
        const directoryHandle = await open(directory, 'r');
        try {
            await directoryHandle.sync();
        } finally {
            await directoryHandle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
}

function probeHostProcess(pid: number): HostProcessState {
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
        if (fileSystemCode(error) === 'ENOENT') return undefined;
        throw error;
    }
}

function assertSameProfile(paths: HostProfilePaths, value: HostLock | HostManifest): void {
    if (value.profileId !== paths.profileId)
        throw new CaxriError(
            'VALIDATION',
            'Host profile metadata is inconsistent; remove it only after verifying no Host is running',
        );
}

async function removeStaleEndpoint(paths: HostProfilePaths): Promise<void> {
    try {
        const endpoint = await lstat(paths.endpoint);
        if (!endpoint.isSocket())
            throw new CaxriError(
                'PATH_DENIED',
                'Host endpoint is not a socket; remove it manually after verifying its owner',
            );
        if (typeof process.getuid === 'function' && endpoint.uid !== process.getuid())
            throw new CaxriError('PATH_DENIED', 'Host endpoint belongs to another user');
        await rm(paths.endpoint);
    } catch (error) {
        if (fileSystemCode(error) !== 'ENOENT') throw error;
    }
}

async function cleanPreviousOwner(
    paths: HostProfilePaths,
    previousLock: HostLock | undefined,
    processState: (pid: number) => HostProcessState,
): Promise<void> {
    const previousManifest = await optionalPrivateJson(readHostManifest, paths.manifest);
    if (!previousLock && !previousManifest) return;
    if (previousLock) assertSameProfile(paths, previousLock);
    if (previousManifest) {
        assertSameProfile(paths, previousManifest);
        if (previousManifest.endpoint !== paths.endpoint)
            throw new CaxriError(
                'VALIDATION',
                'Host manifest endpoint is inconsistent; repair the profile metadata manually',
            );
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
    await removeStaleEndpoint(paths);
    if (previousManifest) await rm(paths.manifest, { force: true });
    await rm(paths.desktopCredential, { force: true });
}

async function manifestOwnedBy(path: string, processIdentity: string) {
    try {
        const value = await readHostManifest(path);
        return value.processIdentity === processIdentity;
    } catch (error) {
        if (fileSystemCode(error) === 'ENOENT') return false;
        throw error;
    }
}

/** Acquires the profile before Runtime startup, preventing a second SQLite writer from spawning. */
export async function acquireHostProfile(options: {
    processState?: (pid: number) => HostProcessState;
    socketDirectory?: string;
    startedAt?: number;
    userDataPath: string;
    version: string;
}): Promise<HostProfileLease> {
    const paths = await resolveHostProfilePaths(options.userDataPath, options.socketDirectory);
    await privateDirectory(paths.directory);
    /** The kernel lock makes both ordinary startup and stale takeover one atomic profile CAS. */
    const lockHandle = await acquireProcessLock(paths.lock);
    const processIdentity = randomBytes(16).toString('hex');
    const startedAt = options.startedAt ?? Date.now();
    const lock = hostLockSchema.parse({
        pid: process.pid,
        startedAt,
        processIdentity,
        profileId: paths.profileId,
    });
    const processState = options.processState ?? probeHostProcess;
    let previousLock: HostLock | undefined;
    try {
        previousLock = await readLockHandle(lockHandle);
    } catch (error) {
        await lockHandle.close();
        throw error;
    }

    try {
        await cleanPreviousOwner(paths, previousLock, processState);
        await writeLockHandle(lockHandle, lock);
        await chmod(paths.lock, 0o600);
    } catch (error) {
        await lockHandle.close();
        throw error;
    }

    const manifest = hostManifestSchema.parse({
        ...lock,
        manifestVersion: HOST_MANIFEST_VERSION,
        endpoint: paths.endpoint,
        protocolVersion: CAXRI_PROTOCOL_VERSION,
        version: options.version,
        operatorToken: randomBytes(32).toString('hex'),
    });
    const desktopCredential = hostDesktopCredentialSchema.parse({
        credentialVersion: HOST_DESKTOP_CREDENTIAL_VERSION,
        profileId: paths.profileId,
        processIdentity,
        desktopToken: randomBytes(32).toString('hex'),
    });
    let published = false;
    let released = false;
    return {
        desktopCredential,
        manifest,
        paths,
        async publish() {
            if (published) return;
            const endpoint = await lstat(paths.endpoint);
            if (!endpoint.isSocket())
                throw new CaxriError('PATH_DENIED', 'Host endpoint is not a Unix socket');
            if (typeof process.getuid === 'function' && endpoint.uid !== process.getuid())
                throw new CaxriError('PATH_DENIED', 'Host endpoint belongs to another user');
            await chmod(paths.endpoint, 0o600);
            await replacePrivateJson(paths.directory, paths.desktopCredential, desktopCredential);
            await replacePrivateJson(paths.directory, paths.manifest, manifest);
            published = true;
        },
        async release() {
            if (released) return;
            released = true;
            try {
                if (await manifestOwnedBy(paths.manifest, processIdentity))
                    await rm(paths.manifest, { force: true });
            } catch {
                /** A corrupted manifest must not prevent release of the authenticated live owner. */
            }
            await rm(paths.desktopCredential, { force: true }).catch(() => undefined);
            try {
                try {
                    if ((await lstat(paths.endpoint)).isSocket())
                        await rm(paths.endpoint, { force: true });
                } catch (error) {
                    if (fileSystemCode(error) !== 'ENOENT') throw error;
                }
            } finally {
                try {
                    await writeLockHandle(lockHandle, undefined);
                } finally {
                    await lockHandle.close();
                }
            }
        },
    };
}
