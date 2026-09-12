import { Buffer } from 'node:buffer';
import { mkdir } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

/**
 * MacOS stores an `AF_UNIX` address in a 104-byte `sun_path` including its terminator, and Linux allows 108. The
 * smaller budget minus the terminator is the only length portable across both, so every Caxri socket is held to it.
 */
export const MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES = 103;

/**
 * `sun_path` is measured in bytes, not characters, so a multi-byte temp directory counts for more than its length.
 */
export function isWithinUnixSocketLimit(path: string): boolean {
    return Buffer.byteLength(path, 'utf8') <= MAX_PORTABLE_UNIX_SOCKET_PATH_BYTES;
}

/**
 * The shortest private root available on every platform that has `AF_UNIX`. `/tmp` is world-writable, so the socket
 * gets a uid-owned directory rather than sitting beside other users' files; {@link ensureUnixSocketDirectory} creates it
 * with `0o700`. `/tmp` is used verbatim instead of resolving it to `/private/tmp` on macOS because `sun_path` stores
 * the literal string, so the unresolved form is eight bytes cheaper.
 */
function shortPrivateSocketRoot(): string {
    return join('/tmp', `caxri-${userInfo().uid}`);
}

/**
 * Places a socket in the caller's preferred directory, falling back to a short uid-owned root when that would exceed
 * the portable `sun_path` limit.
 *
 * The preferred directory wins whenever it fits, so the socket normally stays inside whatever temporary root the caller
 * already owns and is cleaned up with it. It does not always fit: the macOS per-user temp directory is 49 bytes on its
 * own, and any caller that nests a further directory under it — the E2E harness gives each Playwright worker its own
 * `caxri-e2e-<pool>-<index>` TMPDIR — pushes a socket past the limit. Both of Caxri's private sockets failed that way,
 * each with a different symptom and neither naming the real cause: the Managed Agent launcher threw at Terminal Host
 * module top level and surfaced as `pty.spawn_failed` ("Terminal Host exited before ready"), while the Agent lifecycle
 * hook bridge failed its `listen` with `EINVAL` and left hooks quietly uninstalled.
 *
 * Falling back here removes that failure mode for every caller instead of requiring each one to budget its own
 * directory depth. See `scripts/self-hosted-runner.ts`, which solves the same limit for CI by pointing `TMPDIR` at a
 * short `/private/tmp` symlink.
 *
 * @param preferredDirectory Absolute directory the caller would rather use
 * @param name Socket file name, including its extension
 */
export function unixSocketPath(preferredDirectory: string, name: string): string {
    if (!isAbsolute(preferredDirectory)) throw new Error('Unix socket directory must be absolute');
    const preferred = join(preferredDirectory, name);
    if (isWithinUnixSocketLimit(preferred)) return preferred;
    const fallback = join(shortPrivateSocketRoot(), name);
    if (!isWithinUnixSocketLimit(fallback))
        throw new Error('Unix socket path exceeds the portable limit');
    return fallback;
}

/**
 * Creates the directory holding a path returned by {@link unixSocketPath}. The fallback root does not exist on a first
 * run, and `0o700` keeps the socket out of reach of other users on the world-writable `/tmp`.
 */
export async function ensureUnixSocketDirectory(socketPath: string): Promise<void> {
    await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
}
