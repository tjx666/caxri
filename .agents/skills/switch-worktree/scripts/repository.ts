import { randomUUID } from 'node:crypto';
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
    return join(parent, encodeURIComponent(branch));
}

export async function worktreeIdentity(root: string, create: boolean): Promise<string | undefined> {
    const identityPath = (
        await runCapture('git', ['rev-parse', '--git-path', 'caxri-worktree-id'], root)
    ).trim();
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

async function readLockOwner(path: string): Promise<LockOwner> {
    try {
        return JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as LockOwner;
    } catch {
        throw new CommandError(`Invalid repository lock at ${path}; inspect it before continuing`);
    }
}

/** Serialize mutations shared by every linked checkout and reclaim only a verified stale owner. */
export async function withRepositoryLock<T>(
    context: RepositoryContext,
    task: () => Promise<T>,
): Promise<T> {
    await mkdir(context.stateDir, { recursive: true });
    const lockPath = join(context.stateDir, 'operation.lock');
    const cleanupPath = join(context.stateDir, 'operation-lock-cleanup');
    const identity = await getProcessIdentity(process.pid);
    if (!identity) throw new CommandError('Could not establish the worktree launcher identity');

    const deadline = Date.now() + 10_000;
    let acquired = false;
    while (!acquired) {
        if (await pathExists(cleanupPath)) {
            if (Date.now() >= deadline) {
                throw new CommandError('Timed out waiting for stale worktree lock cleanup');
            }
            await new Promise<void>((resolveWait) => setTimeout(resolveWait, 25));
            continue;
        }
        try {
            await mkdir(lockPath);
            await writeFile(
                join(lockPath, 'owner.json'),
                `${JSON.stringify({ identity, pid: process.pid, startedAt: new Date().toISOString() })}\n`,
                'utf8',
            );
            acquired = true;
        } catch (error) {
            if (errorCode(error) !== 'EEXIST') throw error;
            const owner = await readLockOwner(lockPath);
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
                if (!(await isProcessIdentityAlive(latest.pid, latest.identity))) {
                    await rm(lockPath, { recursive: true });
                }
            } catch (cleanupError) {
                if (errorCode(cleanupError) !== 'ENOENT') throw cleanupError;
            } finally {
                await rm(cleanupPath);
            }
        }
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
