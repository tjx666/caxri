import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';

import { MAX_GIT_STATUS_FILES } from '../../shared/ipc/domain';
import { CaxriError } from '../../shared/ipc/errors';
import { mapWithConcurrency } from '../../shared/node/concurrency';
import type { StructuredLogger } from '../../shared/node/logger';
import { logEventCatalog } from '../../shared/node/logger';
import type {
    GitFileStatus,
    GitRepositorySummary as GitRepoSummary,
    GitSummary,
} from '../../shared/types';
import { isOutsideRoot } from '../path-security';
import type { ProjectRootResolver } from '../project-roots';
import { SingleFlight } from '../single-flight';
import type { GitChangeTracker } from './change-tracker';
import { toGitError } from './errors';
import type { GitMetadataWatcher } from './metadata-watcher';
import { RepoStatusStore } from './status';
import type { RepoTopologyRegistry } from './topology';

const MAX_CONCURRENT_GIT_COMMANDS = 8;
/**
 * Working-tree porcelain output is parsed from one bounded buffer; the cap is far above the `MAX_GIT_STATUS_FILES`
 * projection bound so truncation happens at the protocol limit, not here.
 */
const MAX_GIT_STATUS_BUFFER_BYTES = 32 * 1024 * 1024;

interface RepoStatus {
    branch: string;
    head?: string;
    ahead: number;
    behind: number;
    additions: number;
    deletions: number;
    changedFileCount: number;
    truncated: boolean;
    files: GitFileStatus[];
}

interface RepoRoot {
    kind: GitRepoSummary['kind'];
    rootPath: string;
}

export interface GitDirectoryRepo {
    directoryPath: string;
    ignoreRulePaths: readonly string[];
    rootPath: string;
}

interface GitRepoServiceOptions {
    git: (
        cwd: string,
        arguments_: string[],
        options?: { allowFailure?: boolean; maxBufferBytes?: number },
    ) => Promise<string>;
    logger: StructuredLogger;
    topology: RepoTopologyRegistry;
    tracker: GitChangeTracker;
}

/**
 * Per-summary attribution counters for the `git.summary` producer boundary event. Every Git command spawned on behalf
 * of one summary increments `commandCount`, which is what the startup benchmark asserts on instead of individual
 * `git.command` records.
 */
interface SummaryTrace {
    commandCount: number;
    worktreeListed: number;
    worktreeApproved: number;
    childRepositories: number;
    statusFresh: number;
    statusJoined: number;
    statusCoalesced: number;
}

interface ChildCacheEntry {
    approvedKey: string;
    children: RepoRoot[];
    parentGeneration: number;
    topologyGeneration: number;
}

const MAX_CHILD_CACHE_ENTRIES = 256;

function statusKind(code: string): GitFileStatus['kind'] {
    if (code === 'AA' || code === 'DD' || code.includes('U')) return 'conflicted';
    if (code.includes('R')) return 'renamed';
    if (code.includes('D')) return 'deleted';
    if (code.includes('A')) return 'added';
    return 'modified';
}

function parseStatusRecord(
    record: string,
    originalPath?: string,
):
    | {
          code: string;
          path: string;
          originalPath?: string;
          kind?: GitFileStatus['kind'];
      }
    | undefined {
    if (record.startsWith('? ')) return { code: '??', path: record.slice(2), kind: 'untracked' };
    const ordinary = /^1 (\S{2})(?: \S+){6} (.+)$/.exec(record);
    if (ordinary) return { code: ordinary[1], path: ordinary[2] };
    const renamed = /^2 (\S{2})(?: \S+){7} (.+)$/.exec(record);
    if (renamed) return { code: renamed[1], path: renamed[2], originalPath, kind: 'renamed' };
    const conflicted = /^u (\S{2})(?: \S+){8} (.+)$/.exec(record);
    if (conflicted) return { code: conflicted[1], path: conflicted[2], kind: 'conflicted' };
    return undefined;
}

function parseStatus(
    output: string,
): Omit<RepoStatus, 'additions' | 'deletions' | 'changedFileCount' | 'truncated'> {
    const records = output.split('\0').filter(Boolean);
    const files: GitFileStatus[] = [];
    let branch = 'detached';
    let head: string | undefined;
    let ahead = 0;
    let behind = 0;
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.startsWith('# branch.head ')) {
            branch = record.slice('# branch.head '.length);
            continue;
        }
        if (record.startsWith('# branch.oid ')) {
            const oid = record.slice('# branch.oid '.length);
            // Keep the full 40-hex oid: `git.commitDetails` params validate against it, so a
            // shortened head would be rejected when the panel loads the last commit's changes.
            head = oid === '(initial)' ? undefined : oid;
            continue;
        }
        if (record.startsWith('# branch.ab ')) {
            const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
            ahead = Number(match?.[1] ?? 0);
            behind = Number(match?.[2] ?? 0);
            continue;
        }
        const parsed = parseStatusRecord(
            record,
            record.startsWith('2 ') ? records[index + 1] : undefined,
        );
        if (!parsed) continue;
        const code = parsed.code.replaceAll('.', ' ');
        files.push({
            path: parsed.path,
            originalPath: parsed.originalPath,
            index: code[0],
            workingTree: code[1],
            kind: parsed.kind ?? (code === '??' ? 'untracked' : statusKind(code)),
        });
        if (record.startsWith('2 ')) index += 1;
    }
    return { branch, head, ahead, behind, files };
}

function parseLineStats(output: string): Pick<RepoStatus, 'additions' | 'deletions'> {
    let additions = 0;
    let deletions = 0;
    for (const line of output.split('\n')) {
        const [added, deleted] = line.split('\t', 2);
        if (/^\d+$/.test(added)) additions += Number(added);
        if (/^\d+$/.test(deleted)) deletions += Number(deleted);
    }
    return { additions, deletions };
}

export interface GitWorktreeEntry {
    branch: string;
    rootPath: string;
}

/**
 * Shared parser for both Git SecondarySidebar discovery and Session Workbench Root attribution.
 */
export function parseWorktreeEntries(output: string): GitWorktreeEntry[] {
    return output.split('\0\0').flatMap((block) => {
        const fields = block.split('\0').filter(Boolean);
        const rootPath = fields
            .find((field) => field.startsWith('worktree '))
            ?.slice('worktree '.length);
        if (!rootPath) return [];
        const branchField = fields.find((field) => field.startsWith('branch '));
        const branch = branchField
            ? branchField.slice('branch '.length).replace(/^refs\/heads\//, '')
            : 'detached';
        return [{ branch, rootPath }];
    });
}

function parseGitLinkPaths(output: string): string[] {
    return output
        .split('\0')
        .map((record) => /^160000 [0-9a-f]+ \d+\t(.+)$/.exec(record)?.[1])
        .filter((path): path is string => Boolean(path));
}

/**
 * Stable repository identity shared by summaries, `git.changed` payloads, and diagnostics.
 */
export function computeRepoId(rootPath: string): string {
    return createHash('sha256').update(rootPath).digest('hex').slice(0, 20);
}

const repoId = computeRepoId;

function isPathContained(rootPath: string, candidate: string): boolean {
    return !isOutsideRoot(relative(rootPath, candidate));
}

function isApproved(rootPath: string, approvedRoots: string[]): boolean {
    return approvedRoots.some((approvedRoot) => isPathContained(approvedRoot, rootPath));
}

function isHiddenByChildRepo(
    filePath: string,
    child: Pick<RepoRoot, 'kind' | 'rootPath'>,
    parentRootPath: string,
): boolean {
    const childPath = relative(parentRootPath, child.rootPath);
    const normalizedChild = childPath.endsWith(sep) ? childPath.slice(0, -1) : childPath;
    const normalizedFile = filePath.endsWith(sep) ? filePath.slice(0, -1) : filePath;
    if (normalizedFile === normalizedChild && child.kind === 'submodule') return false;
    return (
        normalizedFile === normalizedChild || normalizedFile.startsWith(`${normalizedChild}${sep}`)
    );
}

/**
 * Owns Git repository discovery and containment for a Session: locating the primary repository and its
 * worktrees/submodules/nested repositories underneath an approved Project root, and building the aggregated
 * {@link GitSummary} that other Git operations resolve a repository from. Callers reach this exclusively through
 * {@link GitRepoService.summary} and {@link GitRepoService.resolveRepository}; all path containment enforcement lives
 * here so it is never duplicated by a sibling service.
 */
export class GitRepoService {
    private readonly summaries = new SingleFlight<string, GitSummary>();
    private readonly statuses = new RepoStatusStore<RepoStatus>();
    private readonly childCache = new Map<string, ChildCacheEntry>();
    private readonly refreshNonces = new Map<string, number>();
    private readonly sessionGenerations = new Map<string, number>();
    private nextSessionGeneration = 0;
    private metadataWatcher?: GitMetadataWatcher;

    constructor(
        private readonly paths: ProjectRootResolver,
        private readonly options: GitRepoServiceOptions,
    ) {}

    /**
     * Funnel for every Git command issued on behalf of one summary so the producer boundary event can attribute an
     * exact command count to that summary.
     */
    private tracedGit(
        trace: SummaryTrace,
        cwd: string,
        arguments_: string[],
        options?: { allowFailure?: boolean; maxBufferBytes?: number },
    ): Promise<string> {
        trace.commandCount += 1;
        return this.options.git(cwd, arguments_, options);
    }

    private async loadStatus(trace: SummaryTrace, rootPath: string): Promise<RepoStatus> {
        const [statusOutput, lineStatsOutput] = await Promise.all([
            this.tracedGit(
                trace,
                rootPath,
                ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
                { maxBufferBytes: MAX_GIT_STATUS_BUFFER_BYTES },
            ),
            this.tracedGit(trace, rootPath, ['diff', '--numstat', '--no-renames', 'HEAD', '--'], {
                allowFailure: true,
            }),
        ]);
        const parsed = parseStatus(statusOutput);
        const changedFileCount = parsed.files.length;
        const isTruncated = changedFileCount > MAX_GIT_STATUS_FILES;
        return {
            ...parsed,
            changedFileCount,
            truncated: isTruncated,
            files: isTruncated ? parsed.files.slice(0, MAX_GIT_STATUS_FILES) : parsed.files,
            ...parseLineStats(lineStatsOutput),
        };
    }

    private async canonicalRepositoryRoot(
        trace: SummaryTrace,
        path: string,
    ): Promise<string | undefined> {
        try {
            const canonical = await realpath(path);
            const topLevel = await realpath(
                (await this.tracedGit(trace, canonical, ['rev-parse', '--show-toplevel'])).trim(),
            );
            return topLevel === canonical ? canonical : undefined;
        } catch {
            return undefined;
        }
    }

    private async discoverChildRepositories(
        trace: SummaryTrace,
        parent: RepoRoot,
        approvedRoots: string[],
    ): Promise<RepoRoot[]> {
        const [gitLinkOutput, untrackedDirectoryOutput] = await Promise.all([
            this.tracedGit(trace, parent.rootPath, ['ls-files', '--stage', '-z']),
            this.tracedGit(trace, parent.rootPath, [
                'ls-files',
                '--others',
                '--directory',
                '--exclude-standard',
                '-z',
            ]),
        ]);
        const nestedCandidates = await mapWithConcurrency(
            untrackedDirectoryOutput.split('\0').filter((path) => path.endsWith('/')),
            MAX_CONCURRENT_GIT_COMMANDS,
            async (path) => {
                const candidate = resolve(parent.rootPath, path);
                try {
                    const marker = await lstat(resolve(candidate, '.git'));
                    if (marker.isSymbolicLink()) return;
                    return candidate;
                } catch {
                    return;
                }
            },
        );
        const candidates = [
            ...parseGitLinkPaths(gitLinkOutput).map((path) => ({
                kind: 'submodule' as const,
                path: resolve(parent.rootPath, path),
            })),
            ...nestedCandidates
                .filter((path): path is string => Boolean(path))
                .map((path) => ({ kind: 'nested' as const, path })),
        ];
        const discovered = await mapWithConcurrency(
            candidates,
            MAX_CONCURRENT_GIT_COMMANDS,
            async (candidate): Promise<RepoRoot | undefined> => {
                const rootPath = await this.canonicalRepositoryRoot(trace, candidate.path);
                if (!rootPath || !isApproved(rootPath, approvedRoots)) return undefined;
                return { kind: candidate.kind, rootPath };
            },
        );
        return discovered.filter((value): value is RepoRoot => Boolean(value));
    }

    /**
     * Producer boundary: runs the full discovery/status chain once and records the `git.summary` event that attributes
     * wall time and command count to this production instead of leaving only per-command records. `generation` and
     * `truncated` are wired by the snapshot work tracked in the same change series; they are logged from day one so the
     * benchmark contract is stable.
     */
    private async loadSummary(
        sessionId: string,
        reason: 'request' | 'refresh',
        sessionGeneration: number,
    ): Promise<GitSummary> {
        const startedAt = performance.now();
        const trace: SummaryTrace = {
            commandCount: 0,
            worktreeListed: 0,
            worktreeApproved: 0,
            childRepositories: 0,
            statusFresh: 0,
            statusJoined: 0,
            statusCoalesced: 0,
        };
        let summary: GitSummary;
        try {
            summary = await this.produceSummary(sessionId, trace, {
                force: reason === 'refresh',
                sessionGeneration,
            });
        } catch (error) {
            if (this.sessionGenerations.get(sessionId) === sessionGeneration) {
                this.sessionGenerations.delete(sessionId);
                this.refreshNonces.delete(sessionId);
            } else {
                this.retainReferencedRepositoryState();
            }
            throw error;
        }
        const isCurrentSessionGeneration =
            this.sessionGenerations.get(sessionId) === sessionGeneration;
        if (!isCurrentSessionGeneration) {
            this.retainReferencedRepositoryState();
        } else if (!summary.isRepository) {
            this.sessionGenerations.delete(sessionId);
            this.refreshNonces.delete(sessionId);
        }
        this.options.logger.write('info', logEventCatalog.git.summary, {
            durationMs: performance.now() - startedAt,
            fields: {
                ...trace,
                fileCount: summary.repositories.reduce(
                    (total, repo) => total + repo.files.length,
                    0,
                ),
                generation: summary.repositories[0]?.generation ?? 0,
                truncated: summary.repositories.some((repo) => repo.truncated),
                isRepository: summary.isRepository,
                outcome: 'fresh',
                reason,
            },
        });
        return summary;
    }

    private async snapshotStatus(
        trace: SummaryTrace,
        rootPath: string,
    ): Promise<{ generation: number; status: RepoStatus }> {
        const result = await this.statuses.status(rootPath, () => this.loadStatus(trace, rootPath));
        if (result.outcome === 'fresh') trace.statusFresh += 1;
        else if (result.outcome === 'joined') trace.statusJoined += 1;
        else trace.statusCoalesced += 1;
        return result;
    }

    /**
     * Child repository discovery is far more expensive than one status read, so its result is cached against the exact
     * inputs that can change it: the parent's working tree (status generation), worktree membership (topology
     * generation), and the approved-root set.
     */
    private async childRepositories(
        trace: SummaryTrace,
        parents: readonly RepoRoot[],
        approvedRoots: string[],
        topologyGeneration: number,
    ): Promise<RepoRoot[]> {
        const approvedKey = [...approvedRoots].toSorted((a, b) => a.localeCompare(b)).join('\0');
        const discovered = await Promise.all(
            parents.map(async (parent) => {
                const parentGeneration = this.statuses.generation(parent.rootPath);
                const cached = this.childCache.get(parent.rootPath);
                if (
                    cached?.approvedKey === approvedKey &&
                    cached.parentGeneration === parentGeneration &&
                    cached.topologyGeneration === topologyGeneration
                )
                    return cached.children;
                const children = await this.discoverChildRepositories(trace, parent, approvedRoots);
                this.childCache.delete(parent.rootPath);
                this.childCache.set(parent.rootPath, {
                    approvedKey,
                    children,
                    parentGeneration,
                    topologyGeneration,
                });
                while (this.childCache.size > MAX_CHILD_CACHE_ENTRIES) {
                    const oldest = this.childCache.keys().next().value;
                    if (!oldest) break;
                    this.childCache.delete(oldest);
                }
                return children;
            }),
        );
        const children = discovered.flat();
        trace.childRepositories = children.length;
        return children;
    }

    private async produceSummary(
        sessionId: string,
        trace: SummaryTrace,
        options: { force: boolean; sessionGeneration: number },
    ): Promise<GitSummary> {
        const { root: projectRoot } = await this.paths.resolveSessionPath(sessionId);
        try {
            const approvedRoots = (
                await Promise.all(
                    this.paths.listApprovedProjectRoots().map(async (path) => {
                        try {
                            return await realpath(path);
                        } catch {
                            return;
                        }
                    }),
                )
            ).filter((path): path is string => Boolean(path));
            /**
             * The shared topology registry replaces the per-summary `worktree list` plus per-worktree `rev-parse`
             * chain: a cached topology at the current generation costs zero Git spawns regardless of how many linked
             * worktrees exist.
             */
            const topology = await this.options.topology.topology(projectRoot, {
                force: options.force,
                git: (cwd, arguments_) => this.tracedGit(trace, cwd, arguments_),
            });
            trace.worktreeListed = topology.worktrees.length;
            const hasPrimary = topology.worktrees.some(
                (worktree) => worktree.rootPath === projectRoot,
            );
            if (!hasPrimary || !isApproved(projectRoot, approvedRoots))
                throw Object.assign(new Error('not a git repository'), {
                    stderr: 'not a git repository within an approved Project root',
                });
            const baseRepositories: RepoRoot[] = [
                { kind: 'primary', rootPath: projectRoot },
                ...topology.worktrees.flatMap((worktree) =>
                    worktree.rootPath !== projectRoot &&
                    isApproved(worktree.rootPath, approvedRoots)
                        ? [{ kind: 'worktree' as const, rootPath: worktree.rootPath }]
                        : [],
                ),
            ];
            trace.worktreeApproved = baseRepositories.length - 1;
            if (options.force)
                for (const repo of baseRepositories) this.statuses.bump(repo.rootPath);
            const baseSnapshots = await Promise.all(
                baseRepositories.map((repo) => this.snapshotStatus(trace, repo.rootPath)),
            );
            const children = await this.childRepositories(
                trace,
                baseRepositories,
                approvedRoots,
                topology.generation,
            );
            const roots = [...baseRepositories, ...children].filter(
                (repo, index, repositories) =>
                    repositories.findIndex((candidate) => candidate.rootPath === repo.rootPath) ===
                    index,
            );
            const childRoots = roots.slice(baseRepositories.length);
            if (options.force) for (const repo of childRoots) this.statuses.bump(repo.rootPath);
            const childSnapshots = await Promise.all(
                childRoots.map((repo) => this.snapshotStatus(trace, repo.rootPath)),
            );
            const snapshots = [...baseSnapshots, ...childSnapshots];
            const repositories = roots.map((repo, index): GitRepoSummary => {
                const children = roots.filter(
                    (candidate) =>
                        candidate.rootPath !== repo.rootPath &&
                        isPathContained(repo.rootPath, candidate.rootPath),
                );
                const snapshot = snapshots[index];
                const status = snapshot.status;
                const files = status.files.filter((file) =>
                    children.every(
                        (child) => !isHiddenByChildRepo(file.path, child, repo.rootPath),
                    ),
                );
                return {
                    id: repoId(repo.rootPath),
                    kind: repo.kind,
                    name: basename(repo.rootPath),
                    rootPath: repo.rootPath,
                    branch: status.branch,
                    head: status.head,
                    ahead: status.ahead,
                    behind: status.behind,
                    additions: status.additions,
                    deletions: status.deletions,
                    generation: snapshot.generation,
                    /**
                     * On a truncated snapshot the pre-truncation total is authoritative; otherwise the child-repository
                     * projection filter decides the visible count so every consumer of this generation reports the same
                     * number.
                     */
                    changedFileCount: status.truncated ? status.changedFileCount : files.length,
                    truncated: status.truncated,
                    files,
                };
            });
            if (this.sessionGenerations.get(sessionId) === options.sessionGeneration)
                this.registerProjection(sessionId, projectRoot, topology.repositoryKey, roots);
            return { isRepository: true, repositories };
        } catch (error) {
            /**
             * A missing or unapproved repository is reported in the summary, never as a rejection.
             */
            return {
                isRepository: false,
                repositories: [],
                error: toGitError(error).message,
            };
        }
    }

    /**
     * Records which repositories a Session's summary projected and keeps the metadata watcher attached to the
     * repository group, so later invalidation reaches every mapped Session.
     */
    private registerProjection(
        sessionId: string,
        projectRoot: string,
        repoKey: string,
        roots: readonly RepoRoot[],
    ): void {
        const rootPaths = roots.map((repo) => repo.rootPath);
        this.options.tracker.registerSession(sessionId, projectRoot, repoKey, rootPaths);
        // Fire-and-forget: watcher setup must never delay a summary response; subscribe failures
        // downgrade to the watcher's own polling fallback and are logged there.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void this.metadataWatcher?.watch(repoKey, projectRoot, rootPaths);
    }

    /**
     * Drops repository-shared snapshots created by stale Session work only when no live projection still references
     * them. This preserves sibling Sessions while preventing a late producer from retaining its deleted owner.
     */
    private retainReferencedRepositoryState(): void {
        const referencedRoots = this.options.tracker.referencedRoots();
        this.statuses.retainOnly(referencedRoots);
        for (const root of this.childCache.keys())
            if (!referencedRoots.has(root)) this.childCache.delete(root);
    }

    /**
     * Set after construction because the watcher's classification callbacks point back here.
     */
    attachMetadataWatcher(watcher: GitMetadataWatcher): void {
        this.metadataWatcher = watcher;
    }

    /**
     * Working-tree content changed under a Session root: bump only the owning repositories' status generations and
     * schedule one coalesced `git.changed` invalidation.
     */
    observeWorkingTreeChanges(sessionId: string, changePaths: readonly string[]): void {
        const roots = this.options.tracker.mapChangesToRoots(sessionId, changePaths);
        if (roots.length === 0) return;
        for (const root of roots) this.statuses.bump(root);
        this.options.tracker.scheduleStatusChanged(roots);
    }

    /**
     * Git metadata (HEAD, index, refs) changed for `roots` of one repository group.
     */
    observeMetadataStatus(_repoKey: string, roots: readonly string[]): void {
        const known = this.options.tracker.referencedRoots();
        const affected = roots.filter((root) => known.has(root));
        if (affected.length === 0) return;
        for (const root of affected) this.statuses.bump(root);
        this.options.tracker.scheduleStatusChanged(affected);
    }

    /**
     * Worktree membership or repository config changed: rediscover topology on next read.
     */
    observeMetadataTopology(repoKey: string): void {
        this.options.topology.invalidate(repoKey);
        this.options.tracker.scheduleTopologyChanged(repoKey);
    }

    /**
     * Releases per-Session projections plus the snapshots, child caches, and metadata watchers that no remaining
     * Session references (Project/Session deletion, authorization change).
     */
    evictSessions(sessionIds: readonly string[]): void {
        for (const sessionId of sessionIds) this.sessionGenerations.delete(sessionId);
        this.options.tracker.evictSessions(sessionIds);
        for (const sessionId of sessionIds) this.refreshNonces.delete(sessionId);
        this.retainReferencedRepositoryState();
        // Fire-and-forget: eviction must never block on watcher teardown; failures downgrade to
        // the watcher's own polling fallback and are logged there.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void this.metadataWatcher?.retainOnly(this.options.tracker.referencedRepositoryKeys());
    }

    /**
     * `refresh` is a monotonic user nonce: a value above the Session's last seen nonce forces the newest generation
     * (fresh topology and status) instead of joining cached snapshots.
     */
    summary(sessionId: string, refresh = 0): Promise<GitSummary> {
        let sessionGeneration = this.sessionGenerations.get(sessionId);
        if (sessionGeneration === undefined) {
            sessionGeneration = ++this.nextSessionGeneration;
            this.sessionGenerations.set(sessionId, sessionGeneration);
        }
        const lastNonce = this.refreshNonces.get(sessionId) ?? 0;
        const isForce = refresh > lastNonce;
        if (isForce) this.refreshNonces.set(sessionId, refresh);
        const key = `${sessionId}#${sessionGeneration}#${refresh}`;
        if (this.summaries.has(key))
            this.options.logger.write('debug', logEventCatalog.git.summary, {
                fields: { outcome: 'joined', reason: isForce ? 'refresh' : 'request' },
            });
        return this.summaries.run(key, () =>
            this.loadSummary(sessionId, isForce ? 'refresh' : 'request', sessionGeneration),
        );
    }

    async resolveRepository(sessionId: string, repoIdValue: string): Promise<GitRepoSummary> {
        const summary = await this.summary(sessionId);
        const repo = summary.repositories.find((candidate) => candidate.id === repoIdValue);
        if (!repo)
            throw new CaxriError(
                'PATH_DENIED',
                'Git repository is outside the approved Project roots',
            );
        return repo;
    }

    /**
     * Resolves the repository that owns one listed directory without crossing its Project root.
     */
    async resolveDirectory(
        sessionId: string,
        directory: string,
    ): Promise<GitDirectoryRepo | undefined> {
        const { root: projectRoot, path: directoryPath } = await this.paths.resolveSessionPath(
            sessionId,
            directory,
        );
        const output = await this.options.git(
            directoryPath,
            [
                'rev-parse',
                '--path-format=absolute',
                '--show-toplevel',
                '--git-path',
                'info/exclude',
                '--git-path',
                'config',
                '--git-path',
                'config.worktree',
            ],
            { allowFailure: true },
        );
        const [reportedRoot, ...ignoreRulePaths] = output.trim().split('\n');
        if (!reportedRoot) return undefined;
        try {
            const rootPath = await realpath(reportedRoot);
            /**
             * Project creation stores canonical roots; include the freshly resolved current root for migrated data.
             */
            const approvedRoots = [projectRoot, ...this.paths.listApprovedProjectRoots()];
            if (!isApproved(rootPath, approvedRoots)) return undefined;
            return {
                directoryPath,
                ignoreRulePaths: ignoreRulePaths.filter((path) => path.length > 0),
                rootPath,
            };
        } catch {
            return undefined;
        }
    }
}
