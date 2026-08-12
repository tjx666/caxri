import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { CommandError, getProcessIdentity, isProcessIdentityAlive, runCapture } from './process';

export interface RepositoryContext {
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

export interface RepositoryLockOptions {
    /** Test seam for pausing after owner metadata is durable but before the lock is published. */
    beforeLockPublish?: () => Promise<void>;
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

export async function pathExists(path: string): Promise<boolean> {
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
        .split(/\n\n+/)
        .filter(Boolean)
        .map((section) => {
            const fields = new Map<string, string>();
            let detached = false;
            for (const line of section.split('\n')) {
                const separator = line.indexOf(' ');
                if (separator < 0) {
                    if (line === 'detached') detached = true;
                    continue;
                }
                fields.set(line.slice(0, separator), line.slice(separator + 1));
            }
            const path = fields.get('worktree');
            const head = fields.get('HEAD');
            if (!path || !head) throw new CommandError('Invalid git worktree porcelain output');
            const branchRef = fields.get('branch');
            return {
                branch: branchRef?.replace(/^refs\/heads\//, ''),
                detached,
                head,
                path,
            };
        });
}

export async function repositoryContext(cwd: string): Promise<RepositoryContext> {
    const root = (await runCapture('git', ['rev-parse', '--show-toplevel'], cwd)).trim();
    const commonOutput = (await runCapture('git', ['rev-parse', '--git-common-dir'], root)).trim();
    const commonDir = isAbsolute(commonOutput) ? commonOutput : resolve(root, commonOutput);
    const worktrees = parseWorktreePorcelain(
        await runCapture('git', ['worktree', 'list', '--porcelain'], root),
    );
    const primaryRoot = worktrees[0]?.path;
    if (!primaryRoot) throw new CommandError('Git did not report a primary worktree');
    return {
        commonDir,
        primaryRoot,
        root,
        stateDir: join(commonDir, 'caxri-worktree-state'),
    };
}

export async function listWorktrees(context: RepositoryContext): Promise<WorktreeRecord[]> {
    return parseWorktreePorcelain(
        await runCapture('git', ['worktree', 'list', '--porcelain'], context.root),
    );
}

export function worktreeDirectory(context: RepositoryContext, branch: string): string {
    const parent = join(dirname(context.primaryRoot), `${basename(context.primaryRoot)}-worktrees`);
    /** A portable allowlist excludes percent-encoded separators and Windows-invalid path bytes. */
    const readable = branch
        .replaceAll('/', '-')
        .replaceAll(/[^A-Za-z0-9._-]+/g, '-')
        .slice(0, 80);
    const digest = createHash('sha256').update(branch).digest('hex').slice(0, 8);
    return join(parent, `${readable}-${digest}`);
}

export async function worktreeIdentity(root: string, create: boolean): Promise<string | undefined> {
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
        if (!create) return undefined;
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

export async function ensureProfile(context: RepositoryContext, identity: string): Promise<string> {
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
        /** Older launchers could expose the directory before its owner record was durable. */
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
    }
    try {
        return JSON.parse(source) as LockOwner;
    } catch {
        throw new CommandError(`Invalid repository lock at ${path}; inspect it before continuing`);
    }
}

/** Serialize mutations shared by every linked checkout and reclaim only a verified stale owner. */
export async function withRepositoryLock<T>(
    context: RepositoryContext,
    task: () => Promise<T>,
    options: RepositoryLockOptions = {},
): Promise<T> {
    await mkdir(context.stateDir, { recursive: true });
    const lockPath = join(context.stateDir, 'operation.lock');
    const cleanupPath = join(context.stateDir, 'operation-lock-cleanup');
    const identity = await getProcessIdentity(process.pid);
    if (!identity) throw new CommandError('Could not establish the worktree launcher identity');

    const pendingPath = join(
        context.stateDir,
        `operation-lock-${process.pid}-${randomUUID()}.pending`,
    );
    const deadline = Date.now() + 10_000;
    let acquired = false;
    try {
        await mkdir(pendingPath);
        await writeJsonAtomic(join(pendingPath, 'owner.json'), {
            identity,
            pid: process.pid,
            startedAt: new Date().toISOString(),
        });
        await options.beforeLockPublish?.();
        while (!acquired) {
            if (await pathExists(cleanupPath)) {
                if (Date.now() >= deadline) {
                    throw new CommandError('Timed out waiting for stale worktree lock cleanup');
                }
                await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
                continue;
            }
            if (!(await pathExists(lockPath))) {
                try {
                    /** Publish a directory whose durable owner record already exists. A killed
                     *  worker can leave an unreferenced pending directory, but never an ownerless
                     *  repository lock that poisons every later Electron test. */
                    await rename(pendingPath, lockPath);
                    acquired = true;
                    continue;
                } catch (error) {
                    if (!['EEXIST', 'ENOTEMPTY'].includes(errorCode(error) ?? '')) throw error;
                }
            }
            const owner = await readLockOwner(lockPath);
            if (!owner) {
                if (Date.now() >= deadline)
                    throw new CommandError('Timed out waiting for repository lock owner metadata');
                await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
                continue;
            }
            if (await isProcessIdentityAlive(owner.pid, owner.identity)) {
                if (Date.now() >= deadline) {
                    throw new CommandError(
                        `Timed out waiting for switch-worktree operation PID ${owner.pid}`,
                    );
                }
                await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
                continue;
            }
            try {
                await mkdir(cleanupPath);
            } catch (cleanupError) {
                if (errorCode(cleanupError) !== 'EEXIST') throw cleanupError;
                await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
                continue;
            }
            try {
                const latest = await readLockOwner(lockPath);
                if (latest && !(await isProcessIdentityAlive(latest.pid, latest.identity))) {
                    await rm(lockPath, { recursive: true });
                }
            } catch (cleanupError) {
                if (errorCode(cleanupError) !== 'ENOENT') throw cleanupError;
            } finally {
                await rm(cleanupPath);
            }
        }
    } finally {
        if (!acquired) await rm(pendingPath, { force: true, recursive: true });
    }
    try {
        return await task();
    } finally {
        await rm(lockPath, { recursive: true });
    }
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    const handle = await open(temporary, 'r');
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
    await rename(temporary, path);
}

export async function unlinkIfExists(path: string): Promise<void> {
    await unlink(path).catch((error) => {
        if (errorCode(error) !== 'ENOENT') throw error;
    });
}
