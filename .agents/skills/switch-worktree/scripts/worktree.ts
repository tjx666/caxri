import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, readFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { inspectDesktopLease } from './desktop-lease';
import {
    CommandError,
    getProcessIdentity,
    isProcessIdentityAlive,
    runCapture,
    runInherited,
} from './process';
import {
    ensureProfile,
    errorCode,
    listWorktrees,
    pathExists,
    repositoryContext,
    type RepositoryContext,
    type WorktreeRecord,
    unlinkIfExists,
    withRepositoryLock,
    worktreeDirectory,
    worktreeIdentity,
    writeJsonAtomic,
} from './repository';

const SEMANTIC_BRANCH = /^(?:feat|fix|refactor|perf|docs|test|chore)\/[a-z0-9][a-z0-9._/-]*$/;

interface DevProcessRecord {
    identity: string;
    pid: number;
    startedAt: string;
    token: string;
    worktreeId: string;
    worktreePath: string;
}

export interface WorktreeStatus extends WorktreeRecord {
    ahead: number | null;
    behind: number | null;
    dependencies: 'missing' | 'ready' | 'symlink';
    desktopLease: 'active' | 'active-other' | 'free' | 'stale' | 'stale-other';
    devProcess: 'active' | 'none' | 'stale';
    dirty: boolean;
    managed: boolean;
    profile?: string;
    worktreeId?: string;
}

export interface DoctorResult {
    errors: string[];
    status: WorktreeStatus;
    valid: boolean;
    warnings: string[];
}

export interface CreateOptions {
    base?: string;
    branch: string;
    cwd: string;
    install?: (path: string) => Promise<void>;
}

export interface RemoveOptions {
    cleanProfile: boolean;
    cwd: string;
    target: string;
}

export interface DevLaunchOptions {
    args?: string[];
    command?: string;
    stdoutToStderr?: boolean;
}

async function commandSucceeds(command: string, args: string[], cwd: string): Promise<boolean> {
    try {
        await runCapture(command, args, cwd);
        return true;
    } catch {
        return false;
    }
}

export async function installWorktreeDependencies(
    path: string,
    stdoutToStderr = false,
): Promise<void> {
    const exitCode = await runInherited('ni', [], {
        cwd: path,
        env: process.env,
        stdoutToStderr,
    });
    if (exitCode !== 0) throw new CommandError(`ni failed with exit code ${exitCode}`);
}

async function dependencyState(path: string): Promise<WorktreeStatus['dependencies']> {
    try {
        const stats = await lstat(join(path, 'node_modules'));
        if (stats.isSymbolicLink()) return 'symlink';
        return stats.isDirectory() ? 'ready' : 'missing';
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return 'missing';
        throw error;
    }
}

async function isRealDirectory(path: string): Promise<boolean> {
    try {
        const stats = await lstat(path);
        return stats.isDirectory() && !stats.isSymbolicLink();
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return false;
        throw error;
    }
}

async function assertProfileCleanupSafe(path: string): Promise<void> {
    try {
        const stats = await lstat(path);
        if (!stats.isDirectory() || stats.isSymbolicLink()) {
            throw new CommandError(`Refusing to clean non-directory isolated profile: ${path}`);
        }
    } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
    }
}

async function branchExists(context: RepositoryContext, branch: string): Promise<boolean> {
    return await commandSucceeds(
        'git',
        ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
        context.root,
    );
}

async function upstreamCounts(
    worktree: WorktreeRecord,
): Promise<{ ahead: number | null; behind: number | null }> {
    if (!worktree.branch) return { ahead: null, behind: null };
    try {
        const value = (
            await runCapture(
                'git',
                ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
                worktree.path,
            )
        ).trim();
        const [behind, ahead] = value.split(/\s+/).map(Number);
        return {
            ahead: Number.isFinite(ahead) ? ahead : null,
            behind: Number.isFinite(behind) ? behind : null,
        };
    } catch {
        return { ahead: null, behind: null };
    }
}

function devProcessPath(context: RepositoryContext, identity: string): string {
    return join(context.stateDir, 'processes', `${identity}.json`);
}

async function readDevProcess(
    context: RepositoryContext,
    identity: string | undefined,
): Promise<DevProcessRecord | undefined> {
    if (!identity) return undefined;
    try {
        const candidate = JSON.parse(
            await readFile(devProcessPath(context, identity), 'utf8'),
        ) as Partial<DevProcessRecord>;
        if (
            typeof candidate.identity !== 'string' ||
            typeof candidate.pid !== 'number' ||
            !Number.isInteger(candidate.pid) ||
            candidate.pid <= 0 ||
            typeof candidate.startedAt !== 'string' ||
            typeof candidate.token !== 'string' ||
            candidate.worktreeId !== identity ||
            typeof candidate.worktreePath !== 'string'
        ) {
            throw new Error('invalid process record');
        }
        return candidate as DevProcessRecord;
    } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw new CommandError(
            `Invalid dev process record for worktree ${identity}; inspect it before continuing`,
        );
    }
}

async function inspectOne(
    context: RepositoryContext,
    worktree: WorktreeRecord,
    desktop: Awaited<ReturnType<typeof inspectDesktopLease>>,
): Promise<WorktreeStatus> {
    const identity = await worktreeIdentity(worktree.path, false);
    const processRecord = await readDevProcess(context, identity);
    const processActive = processRecord
        ? await isProcessIdentityAlive(processRecord.pid, processRecord.identity)
        : false;
    const counts = await upstreamCounts(worktree);
    const profile = identity ? join(context.stateDir, 'profiles', identity) : undefined;
    return {
        ...worktree,
        ...counts,
        dependencies: await dependencyState(worktree.path),
        desktopLease:
            desktop.state === 'free'
                ? 'free'
                : desktop.lease.worktreePath === worktree.path
                  ? desktop.state
                  : desktop.state === 'active'
                    ? 'active-other'
                    : 'stale-other',
        devProcess: processRecord ? (processActive ? 'active' : 'stale') : 'none',
        dirty: Boolean(
            (
                await runCapture(
                    'git',
                    ['status', '--porcelain', '--untracked-files=all'],
                    worktree.path,
                )
            ).trim(),
        ),
        managed: Boolean(identity),
        profile: profile && (await isRealDirectory(profile)) ? profile : undefined,
        worktreeId: identity,
    };
}

export async function listWorktreeStatus(cwd: string): Promise<WorktreeStatus[]> {
    const context = await repositoryContext(cwd);
    const [worktrees, desktop] = await Promise.all([
        listWorktrees(context),
        inspectDesktopLease(context.root),
    ]);
    return await Promise.all(worktrees.map((worktree) => inspectOne(context, worktree, desktop)));
}

function resolveExistingTarget(
    worktrees: WorktreeRecord[],
    cwd: string,
    target: string,
): WorktreeRecord | undefined {
    const candidatePath = resolve(cwd, target);
    return worktrees.find(
        (worktree) =>
            worktree.branch === target ||
            resolve(worktree.path) === candidatePath ||
            (isAbsolute(target) && resolve(worktree.path) === resolve(target)),
    );
}

async function setupManagedWorktree(
    context: RepositoryContext,
    path: string,
    install: (path: string) => Promise<void>,
): Promise<void> {
    const identity = await worktreeIdentity(path, true);
    if (!identity) throw new CommandError(`Could not create an identity for ${path}`);
    await ensureProfile(context, identity);
    const existingDependencies = await dependencyState(path);
    if (existingDependencies === 'symlink') {
        throw new CommandError(`Refusing shared node_modules symlink in ${path}`);
    }
    if (existingDependencies === 'ready') return;
    await install(path);
    if ((await dependencyState(path)) !== 'ready')
        throw new CommandError(`ni did not create ${path}/node_modules`);
}

async function repairManagedWorktree(
    context: RepositoryContext,
    worktree: WorktreeRecord,
    install: (path: string) => Promise<void>,
): Promise<WorktreeStatus> {
    const status = await inspectOne(context, worktree, await inspectDesktopLease(context.root));
    if (!status.managed || (status.dependencies === 'ready' && status.profile)) return status;
    await setupManagedWorktree(context, worktree.path, install);
    return await inspectOne(context, worktree, await inspectDesktopLease(context.root));
}

function assertSemanticBranch(branch: string): void {
    if (!SEMANTIC_BRANCH.test(branch)) {
        throw new CommandError(
            'Branch must use feat/, fix/, refactor/, perf/, docs/, test/, or chore/ with a lowercase topic',
            2,
        );
    }
}

export async function createWorktree(options: CreateOptions): Promise<WorktreeStatus> {
    assertSemanticBranch(options.branch);
    const context = await repositoryContext(options.cwd);
    const install = options.install ?? installWorktreeDependencies;
    return await withRepositoryLock(context, async () => {
        const worktrees = await listWorktrees(context);
        const existing = worktrees.find((worktree) => worktree.branch === options.branch);
        if (existing) return await repairManagedWorktree(context, existing, install);
        if (
            !(await commandSucceeds(
                'git',
                ['check-ref-format', '--branch', options.branch],
                context.root,
            ))
        ) {
            throw new CommandError(`Invalid branch name: ${options.branch}`, 2);
        }

        const path = worktreeDirectory(context, options.branch);
        await mkdir(resolve(path, '..'), { recursive: true });
        if (await pathExists(path)) {
            throw new CommandError(`Worktree path already exists: ${path}`);
        }
        const exists = await branchExists(context, options.branch);
        if (exists) {
            await runCapture('git', ['worktree', 'add', path, options.branch], context.root);
        } else {
            const base = options.base ?? 'origin/main';
            if (!options.base)
                await runCapture('git', ['fetch', '--quiet', 'origin', 'main'], context.root);
            await runCapture(
                'git',
                ['worktree', 'add', '-b', options.branch, path, base],
                context.root,
            );
        }
        await setupManagedWorktree(context, path, install);
        const created = (await listWorktrees(context)).find(
            (worktree) => resolve(worktree.path) === resolve(path),
        );
        if (!created) throw new CommandError(`Git did not register new worktree ${path}`);
        return await inspectOne(context, created, await inspectDesktopLease(context.root));
    });
}

export async function switchWorktree(
    cwd: string,
    target: string,
    install: (path: string) => Promise<void> = installWorktreeDependencies,
): Promise<WorktreeStatus> {
    const context = await repositoryContext(cwd);
    return await withRepositoryLock(context, async () => {
        const current = resolveExistingTarget(await listWorktrees(context), cwd, target);
        if (current) return await repairManagedWorktree(context, current, install);
        if (!(await branchExists(context, target)))
            throw new CommandError(`No worktree or local branch matches: ${target}`, 2);
        const path = worktreeDirectory(context, target);
        if (await pathExists(path)) throw new CommandError(`Worktree path already exists: ${path}`);
        await mkdir(resolve(path, '..'), { recursive: true });
        await runCapture('git', ['worktree', 'add', path, target], context.root);
        await setupManagedWorktree(context, path, install);
        const added = (await listWorktrees(context)).find(
            (worktree) => resolve(worktree.path) === resolve(path),
        );
        if (!added) throw new CommandError(`Git did not register worktree ${path}`);
        return await inspectOne(context, added, await inspectDesktopLease(context.root));
    });
}

export async function doctorWorktree(cwd: string, target?: string): Promise<DoctorResult> {
    const context = await repositoryContext(cwd);
    const worktrees = await listWorktrees(context);
    const worktree = target
        ? resolveExistingTarget(worktrees, cwd, target)
        : worktrees.find((candidate) => resolve(candidate.path) === resolve(context.root));
    if (!worktree) throw new CommandError(`No worktree matches: ${target}`, 2);
    const status = await inspectOne(context, worktree, await inspectDesktopLease(context.root));
    const errors: string[] = [];
    const warnings: string[] = [];
    if (status.dependencies === 'missing')
        errors.push('node_modules is missing; run ni in this worktree');
    if (status.dependencies === 'symlink') errors.push('node_modules must not be a symbolic link');
    if (!status.managed) warnings.push('worktree has no switch-worktree identity');
    if (status.managed && !status.profile) errors.push('isolated Caxri profile is missing');
    if (status.devProcess === 'stale') warnings.push('dev process record is stale');
    if (status.desktopLease === 'stale')
        warnings.push('desktop lease is stale and can be reclaimed');
    if (status.desktopLease === 'active-other')
        warnings.push('desktop lease is held by another worktree');
    if (status.desktopLease === 'stale-other')
        warnings.push('another worktree has a stale desktop lease');
    return { errors, status, valid: errors.length === 0, warnings };
}

async function unpushedCommitCount(worktree: WorktreeRecord): Promise<number> {
    if (!worktree.branch) return 1;
    try {
        const output = await runCapture(
            'git',
            ['rev-list', '--count', '@{upstream}..HEAD'],
            worktree.path,
        );
        return Number(output.trim());
    } catch {
        try {
            const output = await runCapture(
                'git',
                ['rev-list', '--count', 'origin/main..HEAD'],
                worktree.path,
            );
            return Number(output.trim());
        } catch {
            return 1;
        }
    }
}

export async function removeWorktree(
    options: RemoveOptions,
): Promise<{ path: string; profileKept: boolean }> {
    const context = await repositoryContext(options.cwd);
    return await withRepositoryLock(context, async () => {
        const worktrees = await listWorktrees(context);
        const worktree = resolveExistingTarget(worktrees, options.cwd, options.target);
        if (!worktree) throw new CommandError(`No worktree matches: ${options.target}`, 2);
        if (resolve(worktree.path) === resolve(context.primaryRoot)) {
            throw new CommandError('Refusing to remove the primary worktree');
        }
        if (resolve(worktree.path) === resolve(context.root)) {
            throw new CommandError('Run remove from another associated checkout');
        }
        if (
            (
                await runCapture(
                    'git',
                    ['status', '--porcelain', '--untracked-files=all'],
                    worktree.path,
                )
            ).trim()
        ) {
            throw new CommandError(`Refusing to remove dirty worktree: ${worktree.path}`);
        }
        if ((await unpushedCommitCount(worktree)) > 0) {
            throw new CommandError(
                `Refusing to remove worktree with unpushed commits: ${worktree.path}`,
            );
        }
        const identity = await worktreeIdentity(worktree.path, false);
        const processRecord = await readDevProcess(context, identity);
        if (
            processRecord &&
            (await isProcessIdentityAlive(processRecord.pid, processRecord.identity))
        ) {
            throw new CommandError(
                `Refusing to remove worktree with active dev PID ${processRecord.pid}`,
            );
        }
        const desktop = await inspectDesktopLease(context.root);
        if (
            desktop.state === 'active' &&
            resolve(desktop.lease.worktreePath) === resolve(worktree.path)
        ) {
            throw new CommandError(
                `Refusing to remove worktree holding desktop lease ${desktop.lease.label}`,
            );
        }
        const profile = identity ? join(context.stateDir, 'profiles', identity) : undefined;
        if (profile && options.cleanProfile) await assertProfileCleanupSafe(profile);
        await runCapture('git', ['worktree', 'remove', worktree.path], context.root);
        if (identity && processRecord) await unlinkIfExists(devProcessPath(context, identity));
        if (profile && options.cleanProfile) {
            await rm(profile, {
                recursive: true,
                force: true,
            });
        }
        return { path: worktree.path, profileKept: !options.cleanProfile };
    });
}

export async function prepareDevWorktree(cwd: string): Promise<{
    context: RepositoryContext;
    profile: string;
    worktreeId: string;
}> {
    const context = await repositoryContext(cwd);
    const dependencies = await dependencyState(context.root);
    if (dependencies !== 'ready') {
        throw new CommandError(
            dependencies === 'symlink'
                ? 'Refusing to start with a shared node_modules symlink'
                : 'node_modules is missing; run ni in this worktree',
        );
    }
    const identity = await worktreeIdentity(context.root, true);
    if (!identity) throw new CommandError('Could not establish worktree identity');
    return { context, profile: await ensureProfile(context, identity), worktreeId: identity };
}

export async function devWorktree(cwd: string, options: DevLaunchOptions = {}): Promise<number> {
    const { context, profile, worktreeId } = await prepareDevWorktree(cwd);
    let child!: ChildProcess;
    let record!: DevProcessRecord;
    const recordPath = devProcessPath(context, worktreeId);
    await withRepositoryLock(context, async () => {
        const existing = await readDevProcess(context, worktreeId);
        if (existing && (await isProcessIdentityAlive(existing.pid, existing.identity))) {
            throw new CommandError(`Development instance already running with PID ${existing.pid}`);
        }
        child = spawn(options.command ?? 'bun', options.args ?? ['run', 'dev'], {
            cwd: context.root,
            env: { ...process.env, CAXRI_USER_DATA_DIR: profile },
            stdio: options.stdoutToStderr ? ['inherit', 'pipe', 'inherit'] : 'inherit',
        });
        if (options.stdoutToStderr) child.stdout?.pipe(process.stderr);
        if (!child.pid) throw new CommandError('Could not start the Caxri development launcher');
        const identity = await getProcessIdentity(child.pid);
        if (!identity) {
            child.kill('SIGTERM');
            throw new CommandError('Could not establish the development launcher identity');
        }
        record = {
            identity,
            pid: child.pid,
            startedAt: new Date().toISOString(),
            token: randomUUID(),
            worktreeId,
            worktreePath: context.root,
        };
        await writeJsonAtomic(recordPath, record);
    });
    const relay = (signal: NodeJS.Signals): void => {
        if (child.exitCode === null) child.kill(signal);
    };
    process.once('SIGINT', relay);
    process.once('SIGTERM', relay);
    try {
        return await new Promise<number>((resolveExit, rejectExit) => {
            child.once('error', rejectExit);
            child.once('exit', (code, signal) => {
                if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
                    rejectExit(new CommandError(`Development launcher exited with ${signal}`));
                } else resolveExit(code ?? (signal ? 130 : 1));
            });
        });
    } finally {
        process.removeListener('SIGINT', relay);
        process.removeListener('SIGTERM', relay);
        const current = await readDevProcess(context, worktreeId);
        if (current?.token === record.token) await unlinkIfExists(recordPath);
    }
}
