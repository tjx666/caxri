import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';

import type {
    GitFileStatus,
    GitRepositorySummary as GitRepoSummary,
    GitSummary,
} from '@caxri/protocol';
import { CaxriError, MAX_GIT_STATUS_FILES } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { fileIdentity, mapWithConcurrency } from '@caxri/system';

import { isOutsideRoot } from '../path-security';
import type { ProjectRootResolver } from '../project-roots';
import { SingleFlight } from '../single-flight';
import type { GitChangeTracker } from './change-tracker';
import { describeGitSummaryFailure } from './errors';
import type { GitMetadataWatcher } from './metadata-watcher';
import { isMissingRepoRoot, MissingRepoRootCache } from './missing-root-cache';
import { measureWorkingTreeLineStats, WORKING_TREE_NUMSTAT_ARGUMENTS } from './numstat';
import { registerGitProjection } from './projection';
import { sharedGitRequest } from './request-signal';
import type { RepoStatus } from './status';
import { loadDetachedHead, parseGitStatus, RepoStatusStore } from './status';
import { GitSummaryTelemetry } from './summary-telemetry';
import type { GitSummaryRequester, SummaryTrace } from './summary-trace';
import type { RepoTopologyRegistry } from './topology';

const MAX_CONCURRENT_GIT_COMMANDS = 8;
/**
 * Working-tree porcelain output is parsed from one bounded buffer; the cap is far above the `MAX_GIT_STATUS_FILES`
 * projection bound so truncation happens at the protocol limit, not here.
 */
const MAX_GIT_STATUS_BUFFER_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_DISCARD_IDENTITY_READS = 32;

/**
 * Git diffs contain tracked content but not untracked bytes. Bind destructive consent to each untracked filesystem
 * identity so replacing or rewriting a same-status path after the native prompt cannot delete a different file.
 */
async function untrackedIdentityFingerprint(
    rootPath: string,
    files: readonly GitFileStatus[],
): Promise<string> {
    const identities = await mapWithConcurrency(
        files.filter(({ kind }) => kind === 'untracked'),
        MAX_CONCURRENT_DISCARD_IDENTITY_READS,
        async (file) => {
            const path = resolve(rootPath, file.path);
            if (isOutsideRoot(relative(rootPath, path)))
                throw new CaxriError(
                    'PATH_DENIED',
                    'Git path is outside the authorized repository',
                );
            try {
                return `${file.path}\0${fileIdentity(await lstat(path, { bigint: true }))}`;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT')
                    return `${file.path}\0missing`;
                throw error;
            }
        },
    );
    return identities.join('\0');
}

/**
 * Full working-tree evidence used by the destructive discard consent boundary. The public Git summary may truncate its
 * file projection, so discard re-reads the complete porcelain stream and binds the confirmation to its digest.
 */
export interface GitDiscardSnapshot {
    authorizedPaths: readonly string[];
    files: readonly GitFileStatus[];
    fingerprint: string;
    repository: GitRepoSummary;
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

interface ChildCacheEntry {
    approvedKey: string;
    children: RepoRoot[];
    parentGeneration: number;
    topologyGeneration: number;
}

const MAX_CHILD_CACHE_ENTRIES = 256;

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
    /**
     * Keyed by Session lifetime; a force arriving mid-flight queues one trailing run that every further force shares
     * instead of racing a parallel producer. See {@link GitRepoService.summary}.
     */
    private readonly summaries = new SingleFlight<string, GitSummary>();
    private readonly statuses = new RepoStatusStore<RepoStatus>();
    private readonly childCache = new Map<string, ChildCacheEntry>();
    private readonly refreshNonces = new Map<string, number>();
    private readonly sessionGenerations = new Map<string, number>();
    private readonly missingRepositoryRoots = new MissingRepoRootCache();
    private readonly telemetry: GitSummaryTelemetry;
    private nextSessionGeneration = 0;
    private metadataWatcher?: GitMetadataWatcher;

    constructor(
        private readonly paths: ProjectRootResolver,
        private readonly options: GitRepoServiceOptions,
    ) {
        this.telemetry = new GitSummaryTelemetry(options.logger);
    }

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
            this.tracedGit(trace, rootPath, WORKING_TREE_NUMSTAT_ARGUMENTS, { allowFailure: true }),
        ]);
        const parsed = parseGitStatus(statusOutput);
        const changedFileCount = parsed.files.length;
        const isTruncated = changedFileCount > MAX_GIT_STATUS_FILES;
        const files = isTruncated ? parsed.files.slice(0, MAX_GIT_STATUS_FILES) : parsed.files;
        const [lineStats, detachedHead] = await Promise.all([
            measureWorkingTreeLineStats(rootPath, files, lineStatsOutput, parsed.head),
            loadDetachedHead(parsed, this.tracedGit.bind(this, trace, rootPath)),
        ]);
        return { ...parsed, detachedHead, changedFileCount, truncated: isTruncated, ...lineStats };
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
        topologyWorktreeRoots: ReadonlySet<string>,
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
                if (
                    !rootPath ||
                    topologyWorktreeRoots.has(rootPath) ||
                    !isApproved(rootPath, approvedRoots)
                )
                    return undefined;
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
        requester: GitSummaryRequester,
    ): Promise<GitSummary> {
        const startedAt = performance.now();
        const trace: SummaryTrace = {
            requester,
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
        this.telemetry.recordProduced(sessionId, summary, performance.now() - startedAt, {
            ...trace,
            fileCount: summary.repositories.reduce((total, repo) => total + repo.files.length, 0),
            generation: summary.repositories[0]?.generation ?? 0,
            truncated: summary.repositories.some((repo) => repo.truncated),
            isRepository: summary.isRepository,
            reason,
        });
        // A production that settles after its Session was evicted must not leave a window behind that only Server
        // close would publish; flush it now so eviction stays the last word for that Session.
        if (!isCurrentSessionGeneration) this.telemetry.flush([sessionId]);
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
        topologyWorktreeRoots: ReadonlySet<string>,
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
                const children = await this.discoverChildRepositories(
                    trace,
                    parent,
                    approvedRoots,
                    topologyWorktreeRoots,
                );
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
        const cachedFailure = await this.missingRepositoryRoots.lookup(projectRoot, options.force);
        if (cachedFailure !== undefined)
            return { isRepository: false, repositories: [], error: cachedFailure };
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
            const baseRepositories: RepoRoot[] = [{ kind: 'primary', rootPath: projectRoot }];
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
                new Set(topology.worktrees.map((worktree) => worktree.rootPath)),
            );
            const roots = [...baseRepositories, ...children].filter(
                (repo, index, repositories) =>
                    repositories.findIndex((candidate) => candidate.rootPath === repo.rootPath) ===
                    index,
            );
            const childRoots = roots.slice(baseRepositories.length);
            /**
             * Each child owns independent metadata, even when its gitDir lives inside the parent's .git.
             */
            const childTopologies = await Promise.all(
                childRoots.map((repo) =>
                    this.options.topology.topology(repo.rootPath, {
                        force: options.force,
                        git: (cwd, arguments_) => this.tracedGit(trace, cwd, arguments_),
                    }),
                ),
            );
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
                for (const { rootPath } of topology.worktrees)
                    if (rootPath !== repo.rootPath && isPathContained(repo.rootPath, rootPath))
                        children.push({ kind: 'worktree', rootPath });
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
                    upstream: status.upstream,
                    detachedHead: status.detachedHead,
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
            if (this.sessionGenerations.get(sessionId) === options.sessionGeneration) {
                const rootPaths = roots.map((repo) => repo.rootPath);
                registerGitProjection(
                    this.options.tracker,
                    this.metadataWatcher,
                    sessionId,
                    projectRoot,
                    [topology, ...childTopologies],
                    rootPaths,
                );
                // A forced summary must invalidate open diffs too, or #1299's outdated check misses a refresh (#1321).
                if (options.force) this.options.tracker.scheduleStatusChanged(rootPaths);
            }
            return { isRepository: true, repositories };
        } catch (error) {
            /**
             * A missing or unapproved repository is reported in the summary, never as a rejection. The cache stores
             * this exact message so a replayed failure is byte-identical to the one it stands in for.
             */
            const failure = describeGitSummaryFailure(error, await isMissingRepoRoot(projectRoot));
            await this.missingRepositoryRoots.remember(projectRoot, failure);
            return { isRepository: false, repositories: [], error: failure };
        }
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
     * Advances status state synchronously after an authorized Server mutation, independent of watcher latency.
     */
    observeWorkingTreeMutation(rootPath: string): void {
        this.observeMetadataStatus('', [rootPath]);
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
        this.telemetry.flush(sessionIds);
        this.retainReferencedRepositoryState();
        // Fire-and-forget: eviction must never block on watcher teardown; failures downgrade to
        // the watcher's own polling fallback and are logged there.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void this.metadataWatcher?.retainOnly(this.options.tracker.referencedRepositoryKeys());
    }

    /**
     * Publishes every open per-Session refresh aggregate at the Server lifecycle boundary so the last window of a run
     * is not lost with the process. Session generations are dropped as well: a production still in flight then settles
     * as a superseded generation and takes the post-eviction flush path instead of reopening a window nobody
     * publishes.
     */
    close(): void {
        this.sessionGenerations.clear();
        this.refreshNonces.clear();
        this.telemetry.flush();
    }

    /**
     * `refresh` is a monotonic user nonce forcing the newest generation instead of a cached snapshot; coalescing keys
     * on Session lifetime only, not the nonce (keying on it used to run a forced refresh and a plain read as two
     * parallel producers — #584/#556). A mid-flight force queues one trailing run so its snapshot postdates it.
     */
    summary(
        sessionId: string,
        refresh = 0,
        requester: GitSummaryRequester = 'renderer',
        shouldForce = false,
    ): Promise<GitSummary> {
        let sessionGeneration = this.sessionGenerations.get(sessionId);
        if (sessionGeneration === undefined) {
            sessionGeneration = ++this.nextSessionGeneration;
            this.sessionGenerations.set(sessionId, sessionGeneration);
        }
        const lastNonce = this.refreshNonces.get(sessionId) ?? 0;
        const isForce = shouldForce || refresh > lastNonce;
        if (refresh > lastNonce) this.refreshNonces.set(sessionId, refresh);
        const reason = isForce ? 'refresh' : 'request';
        const key = `${sessionId}#${sessionGeneration}`;
        const inFlight = this.summaries.get(key);
        /**
         * The nonce is remembered when the force is accepted, but its trailing run only starts after the current
         * producer settles. A re-read carrying that same nonce during the gap must wait for the queued forced run
         * rather than join the pre-click producer, or the user's refresh would render a stale snapshot.
         */
        const awaitsQueuedForce =
            !isForce && refresh > 0 && refresh === lastNonce && this.summaries.isQueued(key);
        if (inFlight && !isForce && !awaitsQueuedForce) {
            this.telemetry.recordJoined(sessionId, requester);
            return sharedGitRequest(() => inFlight);
        }
        if (inFlight)
            this.telemetry.recordQueued(sessionId, requester, this.summaries.isQueued(key));
        const load = () => this.loadSummary(sessionId, reason, sessionGeneration, requester);
        return sharedGitRequest(() =>
            isForce || awaitsQueuedForce
                ? this.summaries.runAfter(key, load)
                : this.summaries.run(key, load),
        );
    }

    /**
     * Forces a fresh producer without advancing another client's numeric refresh sequence.
     */
    refreshSummary(sessionId: string, requester: GitSummaryRequester): Promise<GitSummary> {
        return this.summary(sessionId, 0, requester, true);
    }

    async resolveRepository(sessionId: string, repoIdValue: string): Promise<GitRepoSummary> {
        const summary = await this.summary(sessionId, 0, 'repository');
        const repo = summary.repositories.find((candidate) => candidate.id === repoIdValue);
        if (!repo)
            throw new CaxriError(
                'PATH_DENIED',
                'Git repository is outside the approved Project roots',
            );
        return repo;
    }

    /**
     * Reads full status and binds destructive consent to a fresh, authorized repository projection.
     */
    async discardSnapshot(sessionId: string, repoIdValue: string): Promise<GitDiscardSnapshot> {
        // Refresh the projection before hashing the status stream; that stream remains the consent-race authority.
        const refresh = (this.refreshNonces.get(sessionId) ?? 0) + 1;
        const summary = await this.summary(sessionId, refresh, 'discard');
        const repo = summary.repositories.find((candidate) => candidate.id === repoIdValue);
        if (!repo)
            throw new CaxriError(
                'PATH_DENIED',
                'Git repository is outside the approved Project roots',
            );
        const [statusOutput, trackedContentOutput] = await Promise.all([
            this.options.git(
                repo.rootPath,
                ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'],
                { maxBufferBytes: MAX_GIT_STATUS_BUFFER_BYTES },
            ),
            this.options.git(repo.rootPath, ['diff', '--binary', '--no-ext-diff', 'HEAD', '--'], {
                allowFailure: true,
                maxBufferBytes: MAX_GIT_STATUS_BUFFER_BYTES,
            }),
        ]);
        const parsed = parseGitStatus(statusOutput);
        const untrackedIdentityOutput = await untrackedIdentityFingerprint(
            repo.rootPath,
            parsed.files,
        );
        const authorizedPaths = new Set<string>();
        for (const file of repo.files) {
            authorizedPaths.add(file.path);
            if (file.originalPath) authorizedPaths.add(file.originalPath);
        }
        return {
            authorizedPaths: [...authorizedPaths],
            files: parsed.files,
            fingerprint: createHash('sha256')
                .update(statusOutput)
                .update('\0')
                .update(trackedContentOutput)
                .update('\0')
                .update(untrackedIdentityOutput)
                .digest('hex'),
            repository: repo,
        };
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
