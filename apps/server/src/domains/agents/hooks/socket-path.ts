import { lstat, opendir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import process from 'node:process';

import { defaultUnixSocketDirectory, unixSocketPath } from '@caxri/system';

/**
 * Bounds the sweep by profile-owned candidates rather than by position in the directory. The previous bound counted
 * every entry in the temp directory and stopped at 4096, which made reclamation depend on where the socket happened to
 * land among unrelated files: a routine macOS `$TMPDIR` already holds several thousand entries, so a crashed Server's
 * socket could survive indefinitely while the sweep reported success. Matching the profile prefix is a cheap string
 * compare, and only the profile itself can grow the matching set, so capping that set keeps the expensive `lstat`/`rm`
 * work bounded without letting foreign churn starve the sweep.
 */
const MAX_PROFILE_SOCKET_CANDIDATES = 512;
const MAX_STALE_SOCKET_REMOVALS = 64;

function fileSystemErrorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : undefined;
}

function isProcessAlive(processId: number): boolean {
    try {
        process.kill(processId, 0);
        return true;
    } catch (error) {
        return !['EINVAL', 'ESRCH'].includes(fileSystemErrorCode(error) ?? '');
    }
}

/**
 * Removes only bounded, profile-owned socket entries whose encoded Server PID no longer exists. A crash bypasses
 * `close()`, while a live sibling Server for the same profile must stay intact.
 */
export async function pruneStaleAgentHookSockets(
    directoryPath: string,
    profileId: string,
    currentProcessId = process.pid,
    /**
     * Overrides the candidate cap so a test can prove the bound counts profile-owned sockets rather than directory
     * position. Production always uses {@link MAX_PROFILE_SOCKET_CANDIDATES}.
     */
    maxCandidates = MAX_PROFILE_SOCKET_CANDIDATES,
): Promise<void> {
    const prefix = `caxri-hooks-${profileId}-`;
    let candidates = 0;
    let removed = 0;
    const directory = await opendir(directoryPath);
    for await (const entry of directory) {
        if (candidates >= maxCandidates || removed >= MAX_STALE_SOCKET_REMOVALS) break;
        if (!entry.name.startsWith(prefix) || !entry.name.endsWith('.sock')) continue;
        candidates += 1;
        const encodedProcessId = entry.name.slice(prefix.length, -'.sock'.length);
        if (!/^\d+$/.test(encodedProcessId)) continue;
        const processId = Number(encodedProcessId);
        if (processId === currentProcessId || isProcessAlive(processId)) continue;
        const path = join(directoryPath, entry.name);
        try {
            if ((await lstat(path)).isSocket()) {
                await rm(path, { force: true });
                removed += 1;
            }
        } catch (error) {
            if (fileSystemErrorCode(error) !== 'ENOENT') throw error;
        }
    }
}

/**
 * Resolves this Server process's hook socket path for `profileId` and sweeps sockets left behind by crashed Servers of
 * the same profile.
 *
 * The socket may land outside its preferred directory when that directory is too deep for the `sun_path` limit, so the
 * stale-socket sweep must follow it rather than assume the temp root.
 */
export async function prepareAgentHookSocketPath(profileId: string): Promise<string> {
    const socketPath = unixSocketPath(
        defaultUnixSocketDirectory(),
        `caxri-hooks-${profileId}-${process.pid}.sock`,
    );
    await pruneStaleAgentHookSockets(dirname(socketPath), profileId);
    return socketPath;
}
