import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const OWNER_FILE = 'owner.json';

/**
 * Who currently holds the lifecycle hook install lock, written inside the lock directory itself.
 *
 * The lock guards `agent-hooks/`, one shared registry for every worktree and every Session on the machine, and the
 * maintainer routinely runs several coding-agent Sessions at once. An empty directory says only that _someone_ holds
 * the lock, so a competing Session that judged it abandoned deleted it out from under the Session still inside the
 * critical section; both then wrote the shared registry, and the durable residue was one Agent CLI Session whose hooks
 * silently never installed (github.com/tjx666/caxri/issues/737).
 */
interface InstallLockOwner {
    holderId: string;
    writtenAt: number;
}

function isErrorCode(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

/**
 * Reads the ownership marker, or `undefined` when it is absent or unreadable. An unreadable marker is deliberately not
 * an error: callers treat it as "held by someone else", which is the fail-closed reading.
 */
async function readOwner(lockPath: string): Promise<InstallLockOwner | undefined> {
    try {
        // eslint-disable-next-line caxri/bounded-external-reads -- owner file inside Caxri's own install lock directory
        const parsed: unknown = JSON.parse(await readFile(join(lockPath, OWNER_FILE), 'utf8'));
        if (typeof parsed !== 'object' || parsed === null) return undefined;
        const { holderId, writtenAt } = parsed as Partial<InstallLockOwner>;
        if (typeof holderId !== 'string' || typeof writtenAt !== 'number') return undefined;
        return { holderId, writtenAt };
    } catch {
        return undefined;
    }
}

/**
 * When the current holder last proved it was alive. Falls back to the lock directory's own mtime so a lock whose marker
 * was never written, a crash between creating the directory and marking it, still ages out instead of deadlocking every
 * later install on this machine.
 */
async function heldSince(
    lockPath: string,
    owner: InstallLockOwner | undefined,
): Promise<number | undefined> {
    if (owner) return owner.writtenAt;
    try {
        return (await stat(lockPath)).mtimeMs;
    } catch (error) {
        if (isErrorCode(error, 'ENOENT')) return undefined;
        throw error;
    }
}

/**
 * Drops a lock judged abandoned, but only while it still looks exactly as it did when that judgment was made. Between
 * reading the marker and removing the directory another Session can win the lock outright, and deleting it then would
 * reintroduce the very fault this guards.
 */
async function removeStaleLock(
    lockPath: string,
    observed: InstallLockOwner | undefined,
): Promise<void> {
    const current = await readOwner(lockPath);
    if (current?.holderId !== observed?.holderId || current?.writtenAt !== observed?.writtenAt)
        return;
    await rm(lockPath, { recursive: true, force: true });
}

/**
 * Runs `operation` under the shared lifecycle hook install lock.
 *
 * Acquisition is a `mkdir` race, which the filesystem settles atomically; the marker written straight afterwards is
 * what makes the resulting lock attributable. A holder only ever removes a lock that still names it, so a Session whose
 * lock was taken over cannot go on to delete its successor's.
 *
 * @param sharedPath Directory holding the machine-wide hook registry.
 * @param operation Critical section; the lock is released once it settles.
 */
export async function withAgentHookInstallLock<T>(
    sharedPath: string,
    operation: () => Promise<T>,
): Promise<T> {
    const lockPath = join(sharedPath, 'install.lock');
    const holderId = randomUUID();
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    /**
     * Lock acquisition is inherently sequential: each retry must observe the previous attempt's outcome (mkdir
     * success/EEXIST, staleness check, timeout) before deciding whether to wait and retry.
     */
    while (true) {
        let isCreated = false;
        try {
            // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
            await mkdir(lockPath);
            isCreated = true;
            // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
            await writeFile(
                join(lockPath, OWNER_FILE),
                JSON.stringify({ holderId, writtenAt: Date.now() } satisfies InstallLockOwner),
                'utf8',
            );
            break;
        } catch (error) {
            /**
             * A lock this process created but could not mark belongs to nobody, and every later attempt would have to
             * wait out the full staleness window before reclaiming it.
             */
            if (isCreated) {
                // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
                await rm(lockPath, { recursive: true, force: true });
                throw error;
            }
            if (!isErrorCode(error, 'EEXIST')) throw error;
            // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
            const owner = await readOwner(lockPath);
            // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
            const since = await heldSince(lockPath, owner);
            if (since !== undefined && Date.now() - since > STALE_LOCK_MS)
                // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
                await removeStaleLock(lockPath, owner);
            if (Date.now() >= deadline)
                throw new Error('Timed out waiting for the lifecycle hook install lock', {
                    cause: error,
                });
            // eslint-disable-next-line no-await-in-loop -- see doc comment above: retries are sequential by design
            await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
        }
    }
    try {
        return await operation();
    } finally {
        const owner = await readOwner(lockPath);
        if (owner?.holderId === holderId) await rm(lockPath, { recursive: true, force: true });
    }
}
