import type { Buffer } from 'node:buffer';
import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import process from 'node:process';

import { inspectDesktopLease } from './desktop-lease';
import {
    CommandError,
    getProcessIdentity,
    isProcessIdentityAlive,
    runCapture,
    runInherited,
} from './process';
import type { RepoContext, WorktreeRecord } from './repo';
import {
    ensureProfile,
    errorCode,
    isPathPresent,
    listWorktrees,
    repoContext,
    unlinkIfExists,
    withRepoLock,
    worktreeDirectory,
    worktreeIdentity,
    writeJsonAtomic,
} from './repo';
import { assertBranchContainsBase, hasBranch } from './worktree-branch';
import { explicitCdpPort, resolveWorktreeCdpPort } from './worktree-cdp-port';
import type {
    DevelopmentLaunchOptions,
    DevelopmentProcessRecord,
} from './worktree-development-process';
import { developmentProcessPath, readDevelopmentProcess } from './worktree-development-process';
import type { OrphanProcess } from './worktree-orphans';
import { describeOrphans, orphansByWorktree, toOrphanProcess } from './worktree-orphans';
import type { ProcessEntry, SignalFailureReason, StopOperations } from './worktree-processes';
import {
    defaultStopOperations,
    inspectWorktreeProcesses,
    stopWorktreeProcesses,
} from './worktree-processes';
import { finishProfileRemoval, prepareProfileRemoval } from './worktree-profile-removal';
import { isWorktreeHeadPreserved } from './worktree-removal-safety';

const SEMANTIC_BRANCH = /^(?:feat|fix|refactor|perf|docs|test|chore)\/[a-z0-9][a-z0-9._/-]*$/;

export interface WorktreeStatus extends WorktreeRecord {
    ahead: number | null;
    behind: number | null;
    /**
     * The CDP port from this worktree's dev process record, active or stale; undefined when no dev launch has ever
     * recorded one. See `resolveWorktreeCdpPort` in `worktree-cdp-port.ts`.
     */
    cdpPort?: number;
    dependencies: 'missing' | 'ready' | 'symlink';
    desktopLease: 'active' | 'active-other' | 'free' | 'stale' | 'stale-other';
    devProcess: 'active' | 'none' | 'stale';
    dirty: boolean;
    managed: boolean;
    /**
     * Processes running from this checkout with no live supervisor; see `findOrphanedProcesses`.
     */
    orphanProcesses: OrphanProcess[];
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
    cwd: string;
    preserveProfile: boolean;
    target: string;
}

export interface StopResult {
    path: string;
    stopped: Array<{ command: string; pid: number }>;
    survivors: Array<{ closedReason?: SignalFailureReason; command: string; pid: number }>;
}

async function didCommandSucceed(
    command: string,
    arguments_: string[],
    cwd: string,
): Promise<boolean> {
    try {
        await runCapture(command, arguments_, cwd);
        return true;
    } catch {
        return false;
    }
}

async function restoreManifest(path: string, source: Buffer | undefined): Promise<void> {
    if (!source) {
        await rm(path, { force: true });
        return;
    }
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        await writeFile(temporary, source);
        /**
         * Same-directory rename replaces a symlink entry instead of following it to another file.
         */
        await rename(temporary, path);
    } finally {
        await rm(temporary, { force: true });
    }
}

/**
 * Electron 42+ no longer declares a package lifecycle script, so dependency installation alone does not materialize its
 * binary. Repair only an incomplete install so worktree creation and development startup retain their ready-to-run
 * contracts without repeating a completed download.
 *
 * @see https://github.com/tjx666/caxri/issues/276
 */
async function hasElectronBinaryArtifacts(path: string): Promise<boolean> {
    const electronDirectory = join(path, 'node_modules', 'electron');
    try {
        const executableRelativePath = (await readFile(join(electronDirectory, 'path.txt'), 'utf8'))
            .toString()
            .trim();
        const packageManifest = JSON.parse(
            await readFile(join(electronDirectory, 'package.json'), 'utf8'),
        ) as { version?: unknown };
        const installedVersion = (
            await readFile(join(electronDirectory, 'dist', 'version'), 'utf8')
        )
            .trim()
            .replace(/^v/, '');
        if (
            !executableRelativePath ||
            typeof packageManifest.version !== 'string' ||
            installedVersion !== packageManifest.version
        ) {
            return false;
        }
        const distributionDirectory = resolve(electronDirectory, 'dist');
        const executablePath = resolve(distributionDirectory, executableRelativePath);
        const executableWithinDistribution = relative(distributionDirectory, executablePath);
        if (
            !executableWithinDistribution ||
            executableWithinDistribution === '..' ||
            executableWithinDistribution.startsWith(`..${sep}`) ||
            isAbsolute(executableWithinDistribution)
        ) {
            return false;
        }
        return (await lstat(executablePath)).isFile();
    } catch (error) {
        if (errorCode(error) === 'ENOENT' || error instanceof SyntaxError) return false;
        throw error;
    }
}

async function ensureElectronBinary(
    path: string,
    shouldPipeStdoutToStderr: boolean,
): Promise<void> {
    const electronDirectory = join(path, 'node_modules', 'electron');
    if (await hasElectronBinaryArtifacts(path)) return;

    const installScript = join(electronDirectory, 'install.js');
    if (!(await isPathPresent(installScript))) {
        throw new CommandError(`Electron installer is missing: ${installScript}`);
    }
    const exitCode = await runInherited('node', [installScript], {
        cwd: path,
        env: process.env,
        stdoutToStderr: shouldPipeStdoutToStderr,
    });
    if (exitCode !== 0) {
        throw new CommandError(`Electron binary installation failed with exit code ${exitCode}`);
    }
    if (!(await hasElectronBinaryArtifacts(path))) {
        throw new CommandError(
            `Electron binary installation left incomplete artifacts in ${electronDirectory}`,
        );
    }
}

/**
 * A fresh pnpm virtual store can preserve node-pty's macOS helper without its executable bit. Run the canonical
 * preparation script inside the target checkout so native tests and Server artifact staging work before any task uses
 * that worktree. Generic repository fixtures omit the script and do not need Caxri-specific native preparation.
 */
async function prepareNodePty(path: string, shouldPipeStdoutToStderr: boolean): Promise<void> {
    const script = join(path, 'scripts', 'prepare-node-pty.ts');
    if (!(await isPathPresent(script))) return;
    const exitCode = await runInherited('bun', ['run', 'scripts/prepare-node-pty.ts'], {
        cwd: path,
        env: process.env,
        stdoutToStderr: shouldPipeStdoutToStderr,
    });
    if (exitCode !== 0) {
        throw new CommandError(`node-pty preparation failed with exit code ${exitCode}`);
    }
}

export async function installWorktreeDependencies(
    path: string,
    shouldPipeStdoutToStderr = false,
): Promise<void> {
    const manifestNames = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml'] as const;
    // Each manifest lives at an independent path, so reading them can run concurrently.
    const manifestEntries = await Promise.all(
        manifestNames.map(async (name): Promise<[string, Buffer | undefined]> => {
            const manifestPath = join(path, name);
            try {
                const stats = await lstat(manifestPath);
                if (stats.isSymbolicLink())
                    throw new CommandError(
                        `Refusing dependency install with symbolic link manifest: ${manifestPath}`,
                    );
                if (!stats.isFile())
                    throw new CommandError(
                        `Refusing dependency install with non-file manifest: ${manifestPath}`,
                    );
                return [name, await readFile(manifestPath)];
            } catch (error) {
                if (errorCode(error) !== 'ENOENT') throw error;
                return [name, undefined];
            }
        }),
    );
    const manifests = new Map<string, Buffer | undefined>(manifestEntries);
    let exitCode: number;
    try {
        exitCode = await runInherited('ni', [], {
            cwd: path,
            env: process.env,
            stdoutToStderr: shouldPipeStdoutToStderr,
        });
    } finally {
        /**
         * Dependency installs may rewrite lockfile metadata during a no-change install. A managed worktree must
         * preserve the caller's exact manifests, including existing edits. Each manifest restores to an independent
         * path, so this can also run concurrently.
         */
        await Promise.all(
            [...manifests].map(([name, source]) => restoreManifest(join(path, name), source)),
        );
    }
    if (exitCode !== 0) throw new CommandError(`ni failed with exit code ${exitCode}`);
    await prepareNodePty(path, shouldPipeStdoutToStderr);
    await ensureElectronBinary(path, shouldPipeStdoutToStderr);
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

/**
 * Stops everything this worktree started (the recorded development launcher with its whole subtree, the detached Server
 * Core and Extension Host, and any Electron left behind by an interrupted E2E run) and nothing else.
 *
 * This command exists because the alternative agents reach for is a name match. `pkill -f "Caxri.app"` reads as "this
 * checkout's app" and is in fact "every Caxri on the machine": on 2026-09-11 it terminated the installed
 * `/Applications/Caxri.app` mid-session while cleaning up an interrupted local E2E pool, losing window state and
 * Session persistence. Ownership here is decided by the worktree's own absolute path and by `dev`'s process record.
 *
 * @see https://github.com/tjx666/caxri/issues/802
 */
export async function stopWorktree(
    cwd: string,
    operations: StopOperations = defaultStopOperations,
): Promise<StopResult> {
    const context = await repoContext(cwd);
    const identity = await worktreeIdentity(context.root, false);
    const record = await readDevelopmentProcess(context, identity);
    const launcher =
        record?.worktreePath === context.root &&
        (await isProcessIdentityAlive(record.pid, record.identity))
            ? record
            : undefined;
    const { stopped, survivors } = await stopWorktreeProcesses(
        {
            ...(launcher && { launcherPid: launcher.pid }),
            selfPid: process.pid,
            worktreePath: context.root,
        },
        operations,
    );
    if (record && identity && survivors.every((entry) => entry.pid !== record.pid))
        await unlinkIfExists(developmentProcessPath(context, identity));
    return {
        path: context.root,
        stopped: stopped.map(({ command, pid }) => ({ command, pid })),
        survivors: survivors.map(({ closedReason, command, pid }) => ({
            ...(closedReason && { closedReason }),
            command,
            pid,
        })),
    };
}

async function inspectOne(
    context: RepoContext,
    worktree: WorktreeRecord,
    desktop: Awaited<ReturnType<typeof inspectDesktopLease>>,
    orphans?: ReadonlyMap<string, readonly ProcessEntry[]>,
): Promise<WorktreeStatus> {
    const orphanMap = orphans ?? (await orphansByWorktree(await listWorktrees(context)));
    const identity = await worktreeIdentity(worktree.path, false);
    const processRecord = await readDevelopmentProcess(context, identity);
    const isProcessActive = processRecord
        ? await isProcessIdentityAlive(processRecord.pid, processRecord.identity)
        : false;
    const counts = await upstreamCounts(worktree);
    const profile = identity ? join(context.stateDir, 'profiles', identity) : undefined;
    return {
        ...worktree,
        ...counts,
        cdpPort: processRecord?.cdpPort,
        dependencies: await dependencyState(worktree.path),
        desktopLease:
            desktop.state === 'free'
                ? 'free'
                : desktop.lease.worktreePath === worktree.path
                  ? desktop.state
                  : desktop.state === 'active'
                    ? 'active-other'
                    : 'stale-other',
        devProcess: processRecord ? (isProcessActive ? 'active' : 'stale') : 'none',
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
        orphanProcesses: (orphanMap.get(worktree.path) ?? []).map(toOrphanProcess),
        profile: profile && (await isRealDirectory(profile)) ? profile : undefined,
        worktreeId: identity,
    };
}

export async function listWorktreeStatus(cwd: string): Promise<WorktreeStatus[]> {
    const context = await repoContext(cwd);
    const [worktrees, desktop] = await Promise.all([
        listWorktrees(context),
        inspectDesktopLease(context.root),
    ]);
    const orphans = await orphansByWorktree(worktrees);
    return Promise.all(
        worktrees.map((worktree) => inspectOne(context, worktree, desktop, orphans)),
    );
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
    context: RepoContext,
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
    if (existingDependencies === 'ready' && (await hasElectronBinaryArtifacts(path))) return;
    await install(path);
    if ((await dependencyState(path)) !== 'ready')
        throw new CommandError(`ni did not create ${path}/node_modules`);
    if (!(await hasElectronBinaryArtifacts(path)))
        throw new CommandError(`ni left incomplete Electron artifacts in ${path}/node_modules`);
}

async function repairManagedWorktree(
    context: RepoContext,
    worktree: WorktreeRecord,
    install: (path: string) => Promise<void>,
): Promise<WorktreeStatus> {
    const status = await inspectOne(context, worktree, await inspectDesktopLease(context.root));
    if (
        !status.managed ||
        (status.dependencies === 'ready' &&
            status.profile &&
            (await hasElectronBinaryArtifacts(worktree.path)))
    ) {
        return status;
    }
    await setupManagedWorktree(context, worktree.path, install);
    return inspectOne(context, worktree, await inspectDesktopLease(context.root));
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
    const context = await repoContext(options.cwd);
    const install = options.install ?? installWorktreeDependencies;
    return withRepoLock(context, async () => {
        const worktrees = await listWorktrees(context);
        await assertBranchContainsBase(context.root, options.branch, options.base);
        const existing = worktrees.find((worktree) => worktree.branch === options.branch);
        if (existing) return repairManagedWorktree(context, existing, install);
        if (
            !(await didCommandSucceed(
                'git',
                ['check-ref-format', '--branch', options.branch],
                context.root,
            ))
        ) {
            throw new CommandError(`Invalid branch name: ${options.branch}`, 2);
        }

        const path = worktreeDirectory(context, options.branch);
        await mkdir(resolve(path, '..'), { recursive: true });
        if (await isPathPresent(path)) {
            throw new CommandError(`Worktree path already exists: ${path}`);
        }
        const isExists = await hasBranch(context.root, options.branch);
        if (isExists) {
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
        return inspectOne(context, created, await inspectDesktopLease(context.root));
    });
}

export async function switchWorktree(
    cwd: string,
    target: string,
    install: (path: string) => Promise<void> = installWorktreeDependencies,
): Promise<WorktreeStatus> {
    const context = await repoContext(cwd);
    return withRepoLock(context, async () => {
        const current = resolveExistingTarget(await listWorktrees(context), cwd, target);
        if (current) return repairManagedWorktree(context, current, install);
        if (!(await hasBranch(context.root, target)))
            throw new CommandError(`No worktree or local branch matches: ${target}`, 2);
        const path = worktreeDirectory(context, target);
        if (await isPathPresent(path))
            throw new CommandError(`Worktree path already exists: ${path}`);
        await mkdir(resolve(path, '..'), { recursive: true });
        await runCapture('git', ['worktree', 'add', path, target], context.root);
        await setupManagedWorktree(context, path, install);
        const added = (await listWorktrees(context)).find(
            (worktree) => resolve(worktree.path) === resolve(path),
        );
        if (!added) throw new CommandError(`Git did not register worktree ${path}`);
        return inspectOne(context, added, await inspectDesktopLease(context.root));
    });
}

export async function doctorWorktree(cwd: string, target?: string): Promise<DoctorResult> {
    const context = await repoContext(cwd);
    const worktrees = await listWorktrees(context);
    const worktree = target
        ? resolveExistingTarget(worktrees, cwd, target)
        : worktrees.find((candidate) => resolve(candidate.path) === resolve(context.root));
    if (!worktree) throw new CommandError(`No worktree matches: ${target}`, 2);
    const status = await inspectOne(context, worktree, await inspectDesktopLease(context.root));
    const errors: string[] = [];
    const warnings: string[] = [];
    if (status.dependencies === 'missing') {
        errors.push('node_modules is missing; run ni in this worktree');
    } else if (status.dependencies === 'symlink') {
        errors.push('node_modules must not be a symbolic link');
    }
    if (!status.managed) warnings.push('worktree has no switch-worktree identity');
    if (status.managed && !status.profile) errors.push('isolated Caxri profile is missing');
    if (status.devProcess === 'stale') warnings.push('dev process record is stale');
    const orphanWarning = describeOrphans(status.orphanProcesses);
    if (orphanWarning) warnings.push(orphanWarning);
    switch (status.desktopLease) {
        case 'stale': {
            warnings.push('desktop lease is stale and can be reclaimed');
            break;
        }
        case 'active-other': {
            warnings.push('desktop lease is held by another worktree');
            break;
        }
        case 'stale-other': {
            warnings.push('another worktree has a stale desktop lease');
            break;
        }
        default: {
            break;
        }
    }
    return { errors, status, valid: errors.length === 0, warnings };
}

export async function removeWorktree(
    options: RemoveOptions,
): Promise<{ path: string; profileKept: boolean }> {
    const context = await repoContext(options.cwd);
    return withRepoLock(context, async () => {
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
        if (!(await isWorktreeHeadPreserved(worktree))) {
            throw new CommandError(
                `Refusing to remove worktree whose changes are not preserved on origin: ${worktree.path}`,
            );
        }
        const identity = await worktreeIdentity(worktree.path, false);
        const processRecord = await readDevelopmentProcess(context, identity);
        if (
            processRecord &&
            (await isProcessIdentityAlive(processRecord.pid, processRecord.identity))
        ) {
            throw new CommandError(
                `Refusing to remove worktree with active dev PID ${processRecord.pid}`,
            );
        }
        const live = await inspectWorktreeProcesses({
            selfPid: process.pid,
            worktreePath: worktree.path,
        });
        const active = [...live.owned, ...live.unresolved];
        if (active.length > 0)
            throw new CommandError(
                `Refusing to remove worktree with active processes: PIDs ${active.map(({ pid }) => pid).join(', ')}`,
            );
        const desktop = await inspectDesktopLease(context.root);
        if (
            desktop.state === 'active' &&
            resolve(desktop.lease.worktreePath) === resolve(worktree.path)
        ) {
            throw new CommandError(
                `Refusing to remove worktree holding desktop lease ${desktop.lease.label}`,
            );
        }
        const profileRemoval = await prepareProfileRemoval(
            context.stateDir,
            identity,
            options.preserveProfile,
            worktree.path,
        );
        await runCapture('git', ['worktree', 'remove', worktree.path], context.root);
        if (identity && processRecord)
            await unlinkIfExists(developmentProcessPath(context, identity));
        await finishProfileRemoval(profileRemoval);
        return { path: worktree.path, profileKept: profileRemoval.kept };
    });
}

export async function prepareDevelopmentWorktree(cwd: string): Promise<{
    context: RepoContext;
    profile: string;
    worktreeId: string;
}> {
    const context = await repoContext(cwd);
    const dependencies = await dependencyState(context.root);
    if (dependencies !== 'ready') {
        throw new CommandError(
            dependencies === 'symlink'
                ? 'Refusing to start with a shared node_modules symlink'
                : 'node_modules is missing; run ni in this worktree',
        );
    }
    await ensureElectronBinary(context.root, false);
    const identity = await worktreeIdentity(context.root, true);
    if (!identity) throw new CommandError('Could not establish worktree identity');
    return { context, profile: await ensureProfile(context, identity), worktreeId: identity };
}

export async function developmentWorktree(
    cwd: string,
    options: DevelopmentLaunchOptions = {},
): Promise<number> {
    const { context, profile, worktreeId } = await prepareDevelopmentWorktree(cwd);
    let child!: ChildProcess;
    let record!: DevelopmentProcessRecord;
    const recordPath = developmentProcessPath(context, worktreeId);
    await withRepoLock(context, async () => {
        const existing = await readDevelopmentProcess(context, worktreeId);
        if (existing && (await isProcessIdentityAlive(existing.pid, existing.identity))) {
            throw new CommandError(`Development instance already running with PID ${existing.pid}`);
        }
        // `context.stateDir` (and so this lock) is shared by every worktree of the repository (see
        // `repoContext`), so resolving the port here, rather than before the lock, keeps two
        // simultaneous `dev` launches for different worktrees from racing the same OS-level probe.
        // An explicit `CAXRI_DEV_CDP_PORT` the caller already set (e.g. `audit-ux`'s render-layer
        // tooling pinning a fixed port) wins over the derived one instead of being silently replaced.
        const cdpPort = explicitCdpPort(process.env) ?? (await resolveWorktreeCdpPort(worktreeId));
        child = spawn(options.command ?? 'bun', options.args ?? ['run', 'dev'], {
            cwd: context.root,
            env: {
                ...process.env,
                CAXRI_DEV_CDP_PORT: String(cdpPort),
                CAXRI_USER_DATA_DIR: options.userDataDirectory ?? profile,
                // Read by Preload (see `apps/desktop/src/preload/index.ts`) and exposed to Renderer as
                // `globalThis.__caxriWorktree`, so a CDP connection can verify it reached this worktree's
                // window instead of a sibling's. See issue caxri#1016.
                CAXRI_WORKTREE_PATH: context.root,
            },
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
            cdpPort,
            identity,
            pid: child.pid,
            startedAt: new Date().toISOString(),
            token: randomUUID(),
            worktreeId,
            worktreePath: context.root,
        };
        await writeJsonAtomic(recordPath, record);
        options.onLaunch?.({ cdpPort, profile: options.userDataDirectory ?? profile, worktreeId });
    });
    const relay = (signal: NodeJS.Signals): void => {
        if (child.exitCode === null) child.kill(signal);
    };
    process.once('SIGINT', relay);
    process.once('SIGTERM', relay);
    try {
        return await new Promise<number>((resolve, reject) => {
            child.once('error', reject);
            child.once('exit', (code, signal) => {
                if (signal && signal !== 'SIGINT' && signal !== 'SIGTERM') {
                    reject(new CommandError(`Development launcher exited with ${signal}`));
                } else resolve(code ?? (signal ? 130 : 1));
            });
        });
    } finally {
        process.removeListener('SIGINT', relay);
        process.removeListener('SIGTERM', relay);
        const current = await readDevelopmentProcess(context, worktreeId);
        if (current?.token === record.token) await unlinkIfExists(recordPath);
    }
}
