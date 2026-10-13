import { createHash, randomUUID } from 'node:crypto';
import {
    link,
    lstat,
    mkdir,
    open,
    readFile,
    rename,
    rm,
    unlink,
    writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import process from 'node:process';

import { writeJsonAtomic as writeSharedJsonAtomic } from '../../../../scripts/atomic-json';
import { CommandError, getProcessIdentity, isProcessIdentityAlive, runCapture } from './process';

export interface RepoContext {
    commonDir: string;
    primaryRoot: string;
    root: string;
    stateDir: string;
}

export interface WorktreeRecord {
    branch?: string;
    detached: boolean;
    head: string;
    path: string;
}

interface LockOwner {
    identity: string;
    pid: number;
    startedAt: string;
}

export interface RepoLockOptions {
    /**
     * Test seam for pausing after owner metadata is durable but before the lock is published.
     */
    beforeLockPublish?: () => Promise<void>;
    /**
     * Isolates an already-independent resource mutation from the repository-wide lock failure domain.
     */
    namespace?: string;
}

const WORKTREE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validateWorktreeIdentity(value: string, path: string): string | undefined {
    const identity = value.trim();
    if (!identity) return undefined;
    if (!WORKTREE_ID.test(identity)) {
        throw new CommandError(
            `Invalid worktree identity at ${path}; inspect it before continuing`,
        );
    }
    return identity;
}

export function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException | undefined)?.code;
}

export async function isPathPresent(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
    }
}

function parseWorktreePorcelain(value: string): WorktreeRecord[] {
    return value
        .trim()
        .split(/\n{2,}/)
        .filter(Boolean)
        .map((section) => {
            const fields = new Map<string, string>();
            let isDetached = false;
            for (const line of section.split('\n')) {
                const separator = line.indexOf(' ');
                if (separator === -1) {
                    if (line === 'detached') isDetached = true;
                    continue;
                }
                fields.set(line.slice(0, separator), line.slice(separator + 1));
            }
            const path = fields.get('worktree');
            const head = fields.get('HEAD');
            if (!path || !head) throw new CommandError('Invalid git worktree porcelain output');
            const branchReference = fields.get('branch');
            return {
                branch: branchReference?.replace(/^refs\/heads\//, ''),
                detached: isDetached,
                head,
                path,
            };
        });
}

export async function repoContext(cwd: string): Promise<RepoContext> {
    const root = (await runCapture('git', ['rev-parse', '--show-toplevel'], cwd)).trim();
    const commonOutput = (await runCapture('git', ['rev-parse', '--git-common-dir'], root)).trim();
    const commonDirectory = isAbsolute(commonOutput) ? commonOutput : resolve(root, commonOutput);
    const worktrees = parseWorktreePorcelain(
        await runCapture('git', ['worktree', 'list', '--porcelain'], root),
    );
    const primaryRoot = worktrees[0]?.path;
    if (!primaryRoot) throw new CommandError('Git did not report a primary worktree');
    return {
        commonDir: commonDirectory,
        primaryRoot,
        root,
        stateDir: join(commonDirectory, 'caxri-worktree-state'),
    };
}

export async function listWorktrees(context: RepoContext): Promise<WorktreeRecord[]> {
    return parseWorktreePorcelain(
        await runCapture('git', ['worktree', 'list', '--porcelain'], context.root),
    );
}

export function worktreeDirectory(context: RepoContext, branch: string): string {
    const parent = join(dirname(context.primaryRoot), `${basename(context.primaryRoot)}-worktrees`);
    /**
     * A portable allowlist excludes percent-encoded separators and Windows-invalid path bytes.
     */
    const readable = branch
        .replaceAll('/', '-')
        .replaceAll(/[^\w.-]+/g, '-')
        .slice(0, 80);
    const digest = createHash('sha256').update(branch).digest('hex').slice(0, 8);
    return join(parent, `${readable}-${digest}`);
}

export async function worktreeIdentity(
    root: string,
    shouldCreate: boolean,
): Promise<string | undefined> {
    const identityOutput = (
        await runCapture('git', ['rev-parse', '--git-path', 'caxri-worktree-id'], root)
    ).trim();
    const identityPath = isAbsolute(identityOutput)
        ? identityOutput
        : resolve(root, identityOutput);
    try {
        return validateWorktreeIdentity(await readFile(identityPath, 'utf8'), identityPath);
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        if (!shouldCreate) return undefined;
    }
    const identity = randomUUID();
    try {
        await writeFile(identityPath, `${identity}\n`, { encoding: 'utf8', flag: 'wx' });
        return identity;
    } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        return validateWorktreeIdentity(await readFile(identityPath, 'utf8'), identityPath);
    }
}

export async function ensureProfile(context: RepoContext, identity: string): Promise<string> {
    const profile = join(context.stateDir, 'profiles', identity);
    await mkdir(profile, { recursive: true });
    const stats = await lstat(profile);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
        throw new CommandError(`Isolated profile must be a real directory: ${profile}`);
    }
    return profile;
}

async function readLockOwner(path: string): Promise<LockOwner | undefined> {
    let source: string;
    try {
        source = await readFile(join(path, 'owner.json'), 'utf8');
    } catch (error) {
        /**
         * Older launchers could expose the directory before its owner record was durable.
         */
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
    }
    try {
        return JSON.parse(source) as LockOwner;
    } catch {
        throw new CommandError(`Invalid repository lock at ${path}; inspect it before continuing`);
    }
}

/**
 * Current owners publish a lock only after its owner record is durable, so an ownerless lock is either a legacy
 * launcher mid-publish or the remains of an owner killed while deleting it. That remnant can survive later local
 * invocations, so after a grace period it is reclaimable instead of failing every operation.
 */
async function isOwnerlessLockAbandoned(path: string): Promise<boolean> {
    try {
        return Date.now() - (await lstat(path)).mtimeMs > 5000;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
    }
}

/**
 * Serialize mutations shared by every linked checkout and reclaim only a verified stale owner.
 */
export async function withRepoLock<T>(
    context: RepoContext,
    task: () => Promise<T>,
    options: RepoLockOptions = {},
): Promise<T> {
    await mkdir(context.stateDir, { recursive: true });
    if (options.namespace && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(options.namespace)) {
        throw new CommandError(`Invalid repository lock namespace: ${options.namespace}`);
    }
    const lockName = options.namespace ? `operation-${options.namespace}` : 'operation';
    const lockPath = join(context.stateDir, `${lockName}.lock`);
    const cleanupPath = join(context.stateDir, `${lockName}-lock-cleanup`);
    const identity = await getProcessIdentity(process.pid);
    if (!identity) throw new CommandError('Could not establish the worktree launcher identity');

    const pendingPath = join(
        context.stateDir,
        `${lockName}-lock-${process.pid}-${randomUUID()}.pending`,
    );
    let cleanupPendingPath: string | undefined;
    const deadline = Date.now() + 10_000;
    let isAcquired = false;
    const owner = {
        identity,
        pid: process.pid,
        startedAt: new Date().toISOString(),
    };
    const cleanupCandidate = async (): Promise<string> => {
        if (cleanupPendingPath) return cleanupPendingPath;
        cleanupPendingPath = join(
            context.stateDir,
            `${lockName}-lock-cleanup-${process.pid}-${randomUUID()}.pending`,
        );
        await mkdir(cleanupPendingPath);
        await writeJsonAtomic(join(cleanupPendingPath, 'owner.json'), owner);
        return cleanupPendingPath;
    };
    const didClaimCleanup = async (): Promise<boolean> => {
        const candidate = await cleanupCandidate();
        try {
            /**
             * The complete owner record moves with the directory. This also atomically replaces the empty marker left
             * by the pre-owner implementation, while a live owner directory is non-empty and cannot be replaced.
             */
            await rename(candidate, cleanupPath);
            cleanupPendingPath = undefined;
            return true;
        } catch (error) {
            if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error;
            return false;
        }
    };
    const cleanStaleLock = async (): Promise<void> => {
        let staleLockError: Error | undefined;
        try {
            const latest = await readLockOwner(lockPath);
            const isStale = latest
                ? !(await isProcessIdentityAlive(latest.pid, latest.identity))
                : await isOwnerlessLockAbandoned(lockPath);
            if (isStale) {
                await rm(lockPath, { recursive: true });
            }
        } catch (error) {
            if (errorCode(error) !== 'ENOENT') {
                staleLockError =
                    error instanceof Error
                        ? error
                        : new Error('Failed to clean stale worktree lock');
            }
        }
        /**
         * Retire the published marker atomically before deleting its owner record. Otherwise another contender can
         * replace the briefly ownerless directory while `rm` is traversing it and make the cleanup fail ENOTEMPTY.
         */
        const retiredCleanupPath = `${cleanupPath}.${process.pid}.${randomUUID()}.complete`;
        let isRetired = false;
        try {
            await rename(cleanupPath, retiredCleanupPath);
            isRetired = true;
        } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
        }
        if (isRetired) await rm(retiredCleanupPath, { force: true, recursive: true });
        if (staleLockError) throw staleLockError;
    };
    try {
        await mkdir(pendingPath);
        await writeJsonAtomic(join(pendingPath, 'owner.json'), owner);
        await options.beforeLockPublish?.();
        // Every iteration below depends on the durable filesystem state left by the previous
        // one (pending/cleanup markers, lock ownership), so this polling loop is inherently
        // sequential and cannot be parallelized with Promise.all.
        /* eslint-disable no-await-in-loop -- sequential lock-acquisition poll, see comment above */
        while (!isAcquired) {
            if (await isPathPresent(cleanupPath)) {
                const cleanupOwner = await readLockOwner(cleanupPath);
                if (!cleanupOwner) {
                    if (await didClaimCleanup()) {
                        await cleanStaleLock();
                        continue;
                    }
                } else if (await isProcessIdentityAlive(cleanupOwner.pid, cleanupOwner.identity)) {
                    if (Date.now() >= deadline) {
                        throw new CommandError(
                            `Timed out waiting for repository lock cleanup PID ${cleanupOwner.pid}`,
                        );
                    }
                    await new Promise<void>((resolve) => setTimeout(resolve, 25));
                    continue;
                } else {
                    /**
                     * A worker can be interrupted after claiming cleanup but before removing the stale lock. Rename its
                     * marker first so only one contender reclaims it and no late unlink can delete a new owner.
                     */
                    const abandonedCleanupPath = `${cleanupPath}.${process.pid}.${randomUUID()}.stale`;
                    try {
                        await rename(cleanupPath, abandonedCleanupPath);
                    } catch (error) {
                        if (errorCode(error) !== 'ENOENT') throw error;
                        continue;
                    }
                    await rm(abandonedCleanupPath, { recursive: true });
                    continue;
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
                continue;
            }
            if (!(await isPathPresent(lockPath))) {
                try {
                    /**
                     * Publish a directory whose durable owner record already exists. A killed worker can leave an
                     * unreferenced pending directory, but never an ownerless repository lock that poisons every later
                     * Electron test.
                     */
                    await rename(pendingPath, lockPath);
                    isAcquired = true;
                    continue;
                } catch (error) {
                    if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error;
                }
            }
            const lockOwner = await readLockOwner(lockPath);
            if (!lockOwner) {
                if ((await isOwnerlessLockAbandoned(lockPath)) && (await didClaimCleanup())) {
                    await cleanStaleLock();
                    continue;
                }
                if (Date.now() >= deadline)
                    throw new CommandError('Timed out waiting for repository lock owner metadata');
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
                continue;
            }
            if (await isProcessIdentityAlive(lockOwner.pid, lockOwner.identity)) {
                if (Date.now() >= deadline) {
                    throw new CommandError(
                        `Timed out waiting for switch-worktree operation PID ${lockOwner.pid}`,
                    );
                }
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
                continue;
            }
            if (!(await didClaimCleanup())) {
                await new Promise<void>((resolve) => setTimeout(resolve, 25));
                continue;
            }
            await cleanStaleLock();
        }
        /* eslint-enable no-await-in-loop */
    } finally {
        await Promise.all([
            rm(pendingPath, { force: true, recursive: true }),
            cleanupPendingPath
                ? rm(cleanupPendingPath, { force: true, recursive: true })
                : Promise.resolve(),
        ]);
    }
    try {
        return await task();
    } finally {
        /**
         * Retire the lock atomically before deleting its owner record, so a kill mid-delete cannot leave an ownerless
         * lock behind.
         */
        const releasedPath = `${lockPath}.${process.pid}.${randomUUID()}.released`;
        await rename(lockPath, releasedPath);
        await rm(releasedPath, { recursive: true });
    }
}

/**
 * Preserves switch-worktree's parent-creation contract while sharing publication semantics.
 */
export function writeJsonAtomic(path: string, value: unknown): Promise<void> {
    return writeSharedJsonAtomic(path, value, { ensureParent: true });
}

/**
 * Exclusive-create variant of {@link writeJsonAtomic}: the fully written, synced document is published with `link(2)`,
 * which either installs it at the destination in one atomic step or fails when the destination already exists
 * (returning `false`). Unlike `open('wx')` followed by a separate write, a lock-free reader can never observe a
 * partially written file.
 */
export async function didWriteJsonExclusive(path: string, value: unknown): Promise<boolean> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const handle = await open(temporary, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
    try {
        await link(temporary, path);
        return true;
    } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        return false;
    } finally {
        await unlinkIfExists(temporary);
    }
}

export async function unlinkIfExists(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
    }
}
