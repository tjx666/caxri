import { homedir } from 'node:os';

import type {
    GitRepositorySummary as GitRepoSummary,
    ProjectStatusError,
    ProjectStatusLinearIssue,
    ProjectStatusOverview,
    ProjectStatusRepository as ProjectStatusRepo,
    ProjectStatusSummary,
    SessionPullRequest,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, SingleFlight } from '@caxri/system';
import { rememberBounded } from '@caxri/utils';

import type { ExternalStatusRunner, ExternalStatusSource } from '../external-status';
import {
    AcceptanceStore,
    ExternalStatusCommandTelemetry,
    GitHubPullRequestStore,
    isNoPullRequest,
    LinearIssueStore,
    runExternalStatusCommand,
} from '../external-status';
import type { GitService } from '../git';
import { loadPullRequestAcceptances } from './acceptance';
import type { BranchPublicationContext } from './branch';
import {
    prepareStatusRepo,
    readBranchPublication,
    RemoteHeadCache,
    RepoRemoteCache as RepoRemoteCache,
} from './branch';
import { summaryCacheTtlMs } from './cache-ttl';
import type { PreparedRepo, PreparedSummary, SummaryCacheEntry } from './carry-over';
import { pendingSummaryEntry, preparedFingerprint } from './carry-over';
import { EmptyCheckRollupTracker } from './empty-check-rollup';
import { emptyGitHubLoad, failedGitHubLoad } from './github-load';
import { loadPullRequestLinearIssues } from './linear';
import type { ProjectStatusMerge } from './merge-tracker';
import type { ProjectStatusClock, ProjectStatusServiceOptions } from './options';
import { projectStatusClock } from './options';
import { loadProjectStatusOverview } from './overview';
import { parseGitHubPullRequest } from './parse';
import { PullRequestExtras } from './pull-request-extras';
import { refreshLogRecord } from './refresh-log';
import { ResidentPoll } from './resident-poll';
import type { PullRequestTarget, SessionPullRequestResolver } from './session-pull-request';
import { repoPullRequestNumber, resolvePullRequestTarget } from './session-pull-request';
import { ProjectStatusSummaryObservers } from './summary-observers';
import { VercelDeploymentStore } from './vercel-store';
import type { WatchOutcome, WatchRound } from './watch';
import { deliveryKeys, DeliveryWatch, isWatchFresh } from './watch';

const SUMMARY_CACHE_LIMIT = 128;
/**
 * Only a slow local preparation is written. Every watch round prepares each watched Session, which wrote ~6,000
 * `project_status.local` records per 4 hours with a 30ms median; `project_status.watch` already aggregates the round,
 * so the per-call record is kept only as the outlier signal (production p99 was ~600ms, max ~10s).
 */
const SLOW_LOCAL_PREPARE_MS = 250;
export class ProjectStatusService {
    private readonly requests = new SingleFlight<string, ProjectStatusSummary>();
    private readonly overviewRequests = new SingleFlight<string, ProjectStatusOverview>();
    private readonly refreshes = new SingleFlight<string, void>();
    private readonly summaries = new Map<string, SummaryCacheEntry>();
    private readonly sessionGenerations = new Map<string, number>();
    private nextSessionGeneration = 0;
    /**
     * Shared Vercel reader. It owns the `owner/repo` → Vercel project map this panel's deployment tree needs, so the
     * expensive discovery is paid once per process even though the sidebar's delivery badge reads it too.
     */
    private readonly vercel: VercelDeploymentStore;
    private readonly acceptance: AcceptanceStore;
    private readonly github: GitHubPullRequestStore;
    private readonly extras: PullRequestExtras;
    private readonly linear: LinearIssueStore;
    private readonly observers: ProjectStatusSummaryObservers;
    private resolveSessionPullRequest?: SessionPullRequestResolver;
    private readonly residentPoll: ResidentPoll;
    private readonly watch?: DeliveryWatch;
    private readonly commandTelemetry: ExternalStatusCommandTelemetry;
    private readonly clock: ProjectStatusClock;
    private readonly emptyCheckRollups = new EmptyCheckRollupTracker();
    private readonly remotes = new RepoRemoteCache(() => this.now());
    private readonly remoteHeads = new RemoteHeadCache(() => this.now());
    private readonly readGit = (cwd: string, arguments_: readonly string[]) =>
        this.commandTelemetry.readOptional('git', arguments_, () =>
            this.runner('git', arguments_, cwd),
        );

    constructor(
        private readonly git: Pick<GitService, 'summary'>,
        private readonly logger: StructuredLogger,
        private readonly runner: ExternalStatusRunner = runExternalStatusCommand,
        private readonly options: ProjectStatusServiceOptions = {},
    ) {
        this.clock = projectStatusClock(options);
        this.residentPoll = new ResidentPoll({
            clock: this.clock,
            expiresAt: (sessionId) => this.summaries.get(sessionId)?.expiresAt ?? 0,
            logger,
            refresh: (sessionId) => this.summary(sessionId),
        });
        this.observers = new ProjectStatusSummaryObservers({
            areAlertsEnabled: () => this.areAlertsEnabled(),
            emit: options.emit,
            logger,
            now: () => this.now(),
        });
        const { cli } = logEventCatalog.projectStatus;
        this.commandTelemetry = new ExternalStatusCommandTelemetry(logger, cli, () => this.now());
        const { listWatchedSessions } = options;
        if (listWatchedSessions) {
            this.watch = new DeliveryWatch({
                ...this.clock,
                isEnabled: () => this.areAlertsEnabled(),
                listSessions: listWatchedSessions,
                logger,
                polledSessionIds: () => this.residentPoll.polled,
                summaryOf: (sessionId) => this.summaries.get(sessionId)?.value,
                watchSession: (sessionId, round, isPendingRound) =>
                    this.watchSession(sessionId, round, isPendingRound),
            });
        }
        this.github =
            options.github ?? new GitHubPullRequestStore(this.runner, { now: () => this.now() });
        this.extras = new PullRequestExtras(this.commandTelemetry, this.runner, () => this.now());
        this.vercel =
            options.vercel ?? new VercelDeploymentStore(this.runner, { now: () => this.now() });
        /**
         * One store for both Linear readers in this Service: the Status panel's issue rows and the status bar's leading
         * issue, so a Session's Linear state costs one CLI spawn per issue rather than two.
         */
        this.linear = new LinearIssueStore(
            (arguments_, cwd, subject) => this.runCommand('linear', arguments_, cwd, subject),
            { now: () => this.now() },
        );
        /**
         * Same sharing as Linear above, and for the same reason: the Status panel's acceptance rows and the status
         * bar's leading report ask for the same bundles, so one store means one `lh` spawn per report.
         */
        this.acceptance = new AcceptanceStore(
            (arguments_, cwd) => this.runCommand('lh', arguments_, cwd),
            { now: () => this.now() },
        );
    }

    private now(): number {
        return this.clock.now();
    }

    private ignoredChecks(): readonly string[] {
        return this.options.settings?.()['projectStatus.ignoredChecks'] ?? [];
    }

    private async runCommand(
        command: ExternalStatusSource,
        arguments_: readonly string[],
        cwd: string,
        subject?: string,
    ): Promise<string> {
        return this.commandTelemetry.observe({
            command,
            arguments: arguments_,
            subject,
            isOptional: command === 'git', // Only branch publication's local ahead/behind probes, which fall back.
            run: () => this.runner(command, arguments_, cwd),
        });
    }

    private logExternalParseFailure(command: ExternalStatusSource, error: unknown): void {
        this.commandTelemetry.recordParseFailure(command, error);
    }

    private async prepareSummary(
        sessionId: string,
        isForced = false,
        trackingHeads?: Map<string, Promise<string>>,
    ): Promise<PreparedSummary> {
        const startedAt = performance.now();
        const gitSummary = await this.git.summary(sessionId, 0, 'projectStatus');
        if (!gitSummary.isRepository) {
            return {
                repositories: [],
                summary: { repositories: [], refreshedAt: this.now(), error: gitSummary.error },
            };
        }
        const visibleRepositories: GitRepoSummary[] = [];
        for (const repo of gitSummary.repositories)
            if (repo.kind !== 'worktree') visibleRepositories.push(repo);
        const repositories = await Promise.all(
            visibleRepositories.map((repo) =>
                prepareStatusRepo(repo, this.readGit, this.remotes, isForced, trackingHeads),
            ),
        );
        const summary = {
            repositories: repositories.map(({ repository }) => repository),
            refreshedAt: this.now(),
        };
        const fingerprint = preparedFingerprint(this.ignoredChecks(), repositories);
        const durationMs = performance.now() - startedAt;
        if (durationMs >= SLOW_LOCAL_PREPARE_MS)
            this.logger.write('info', logEventCatalog.projectStatus.local, {
                durationMs,
                fields: { repositories: repositories.length },
            });
        return { fingerprint, repositories, summary };
    }

    private async refreshRepository(
        prepared: PreparedRepo,
        isForced: boolean,
        target: PullRequestTarget,
    ): Promise<ProjectStatusRepo> {
        const github = this.loadGitHub(
            prepared.repository.rootPath,
            prepared.context,
            isForced,
            repoPullRequestNumber(target, prepared.context),
        );
        const [githubState, vercelState, branchState] = await Promise.all([
            github,
            (async () => {
                const state = await github;
                return this.vercel.deployments(
                    {
                        onParseFailure: (error) => this.logExternalParseFailure('vc', error),
                        run: (arguments_, cwd) => this.runCommand('vc', arguments_, cwd),
                    },
                    prepared.context,
                    prepared.repository.rootPath,
                    state.mergeCommit,
                    isForced,
                );
            })(),
            readBranchPublication(
                prepared.context,
                (source, arguments_, cwd) => this.runCommand(source, arguments_, cwd),
                prepared.repository.rootPath,
                () => this.now(),
                prepared.repository.githubUrl,
                { cache: this.remoteHeads, isForced },
            ),
        ]);
        return {
            ...prepared.repository,
            publication: branchState.publication,
            branchUrl: branchState.branchUrl,
            pullRequest: githubState.pullRequest,
            linearIssues: githubState.linearIssues,
            acceptances: githubState.acceptances,
            deployments: vercelState.deployments,
            errors: [
                ...githubState.errors,
                ...vercelState.errors,
                ...(branchState.error &&
                githubState.errors.every((error) => error.source !== 'github')
                    ? [branchState.error]
                    : []),
            ],
        };
    }

    private async loadGitHub(
        cwd: string,
        context: BranchPublicationContext,
        isForced: boolean,
        number: number | undefined,
    ): Promise<
        Pick<ProjectStatusRepo, 'pullRequest' | 'linearIssues' | 'acceptances'> & {
            mergeCommit?: string;
            errors: ProjectStatusError[];
        }
    > {
        const empty = emptyGitHubLoad;
        if (!context.owner || !context.repo || !context.branch) return empty();
        try {
            const output = await this.github.view({
                ...(number ? { number } : { branch: context.branch }),
                cwd,
                // An explicit user refresh must reach GitHub; an automatic revalidation may reuse the shared record.
                maxAgeMs: isForced ? 0 : undefined,
                owner: context.owner,
                repo: context.repo,
            });
            if (!output) return empty();
            const parsed = parseGitHubPullRequest(output, this.ignoredChecks());
            parsed.pullRequest = this.emptyCheckRollups.settle(parsed.pullRequest, this.now());
            /**
             * Both readers work from the same already-fetched body, and neither blocks the other: a Linear outage must
             * not hide the acceptance verdict, and an `lh` that is not installed must not hide the linked issues.
             */
            const [linear, acceptance, pullRequest] = await Promise.all([
                loadPullRequestLinearIssues(this.linear, cwd, parsed.body, {
                    isForced,
                    onParseFailure: (error) => this.logExternalParseFailure('linear', error),
                }),
                loadPullRequestAcceptances(this.acceptance, cwd, parsed.body, {
                    isForced,
                    onParseFailure: (error) => this.logExternalParseFailure('lh', error),
                }),
                this.extras.attach(cwd, context, parsed.pullRequest, {
                    ignoredChecks: this.ignoredChecks(),
                    isForced,
                }),
            ]);
            return {
                pullRequest,
                mergeCommit: parsed.mergeCommit,
                linearIssues: linear.issues,
                acceptances: acceptance.acceptances,
                errors: [
                    ...(linear.error ? [linear.error] : []),
                    ...(acceptance.error ? [acceptance.error] : []),
                ],
            };
        } catch (error) {
            if (isNoPullRequest(error)) return empty();
            this.logExternalParseFailure('gh', error);
            return failedGitHubLoad(error);
        }
    }

    /**
     * Refreshes one background Session's delivery status unless another Session in this round already covered the same
     * repository and branch. Deduplication runs on the local Git projection, so a Session that has since switched
     * branches is judged by the branch it is on now rather than the one it last reported.
     */
    private async watchSession(
        sessionId: string,
        { covered, trackingHeads }: WatchRound,
        isPendingRound: boolean,
    ): Promise<WatchOutcome> {
        const generation = this.sessionGeneration(sessionId);
        const prepared = await this.prepareSummary(sessionId, false, trackingHeads);
        if (!prepared.fingerprint || this.sessionGenerations.get(sessionId) !== generation)
            return 'skipped';
        const keys = deliveryKeys(prepared.summary);
        if (keys.length === 0) return 'skipped';
        if (keys.every((key) => covered.has(key))) return 'duplicate';
        for (const key of keys) covered.add(key);
        const previous = this.summaries.get(sessionId);
        if (isWatchFresh(previous, prepared.fingerprint, this.now(), isPendingRound))
            return 'fresh';
        this.rememberSummary(
            sessionId,
            pendingSummaryEntry(prepared, prepared.fingerprint, previous),
        );
        await this.refreshSummary(sessionId, prepared, generation, false);
        return 'refreshed';
    }

    private sessionGeneration(sessionId: string): number {
        let generation = this.sessionGenerations.get(sessionId);
        if (generation === undefined) {
            generation = ++this.nextSessionGeneration;
            this.sessionGenerations.set(sessionId, generation);
        }
        return generation;
    }

    private areAlertsEnabled(): boolean {
        return this.options.settings?.()['projectStatus.notifications.enabled'] === true;
    }

    private rememberSummary(sessionId: string, entry: SummaryCacheEntry): void {
        rememberBounded(
            this.summaries,
            sessionId,
            entry,
            this.options.cacheLimit ?? SUMMARY_CACHE_LIMIT,
        );
    }

    /**
     * Best effort: `refreshSummary` logs its own failure and the change event converges the panel.
     */
    private async rereadSummary(sessionId: string): Promise<void> {
        try {
            await this.summary(sessionId);
        } catch {
            // Intentionally ignored, see above.
        }
    }

    /**
     * Refreshes delivery metadata outside the request path. The fingerprint check prevents a slow result for an old
     * branch or workbench root from replacing a newer Session context.
     */
    private async refreshSummary(
        sessionId: string,
        prepared: PreparedSummary,
        sessionGeneration: number,
        isForced: boolean,
    ): Promise<void> {
        const fingerprint = prepared.fingerprint;
        if (!fingerprint || this.sessionGenerations.get(sessionId) !== sessionGeneration) return;
        const refreshKey = `${sessionId}\0${sessionGeneration}\0${fingerprint}`;
        try {
            await this.refreshes.run(refreshKey, async () => {
                const startedAt = performance.now();
                /**
                 * Resolved here rather than folded into the fingerprint: `prepareSummary` must stay local, so a Session
                 * whose pull request changes without a branch or HEAD move converges on the next TTL-paced refresh.
                 */
                const target = await resolvePullRequestTarget(
                    this.resolveSessionPullRequest,
                    sessionId,
                );
                const repositories = await Promise.all(
                    prepared.repositories.map((repo) =>
                        this.refreshRepository(repo, isForced, target),
                    ),
                );
                if (
                    this.sessionGenerations.get(sessionId) !== sessionGeneration ||
                    this.summaries.get(sessionId)?.fingerprint !== fingerprint
                )
                    return;
                const value = { repositories, refreshedAt: this.now() };
                const hasFailures = repositories.some((repo) => repo.errors.length > 0);
                const ttl = summaryCacheTtlMs(value, hasFailures, this.options);
                this.rememberSummary(sessionId, {
                    expiresAt: this.now() + ttl,
                    fingerprint,
                    refreshToken: this.summaries.get(sessionId)?.refreshToken,
                    value,
                });
                const record = refreshLogRecord(repositories, ttl);
                this.logger.write(record.level, logEventCatalog.projectStatus.refresh, {
                    durationMs: performance.now() - startedAt,
                    fields: record.fields,
                });
                this.observers.observe(sessionId, value);
                this.options.emit?.({ event: 'projectStatus.changed', payload: { sessionId } });
                // The fresh TTL is what paces the next resident poll, so re-arm against it rather than the stale one.
                this.residentPoll.schedule();
            });
        } catch (error) {
            if (this.sessionGenerations.get(sessionId) !== sessionGeneration) return;
            this.logger.write('error', logEventCatalog.projectStatus.refreshFailed, {
                fields: { code: error instanceof CaxriError ? error.code : 'INTERNAL' },
            });
        }
    }

    private async loadSummary(
        sessionId: string,
        sessionGeneration: number,
        refreshToken?: string,
    ): Promise<ProjectStatusSummary> {
        const startedAt = performance.now();
        const prepared = await this.prepareSummary(sessionId, refreshToken !== undefined);
        if (this.sessionGenerations.get(sessionId) !== sessionGeneration) return prepared.summary;
        if (!prepared.fingerprint) {
            this.sessionGenerations.delete(sessionId);
            this.summaries.delete(sessionId);
            return prepared.summary;
        }
        const previous = this.summaries.get(sessionId);
        let cached = pendingSummaryEntry(prepared, prepared.fingerprint, previous, refreshToken);
        const isFingerprintChanged = cached !== previous;
        const isForceRefresh = refreshToken !== undefined && cached.refreshToken !== refreshToken;
        if (isForceRefresh) cached = { ...cached, refreshToken };
        this.rememberSummary(sessionId, cached);
        /**
         * `carried` marks a fingerprint change answered from the previous entry's delivery status (see
         * `carryOverDelivery`), so how often a background HEAD move is absorbed stays measurable apart from TTL
         * expiry.
         */
        let source: 'carried' | 'fresh' | 'local' | 'stale' = 'local';
        if (isFingerprintChanged && cached.value) source = 'carried';
        else if (cached.value) source = cached.expiresAt > this.now() ? 'fresh' : 'stale';
        if (isForceRefresh) await this.refreshSummary(sessionId, prepared, sessionGeneration, true);
        else if (source !== 'fresh') {
            // The cache event owns UI convergence for automatic stale-while-revalidate loads.
            void this.refreshSummary(sessionId, prepared, sessionGeneration, false);
        }
        this.logger.write('info', logEventCatalog.projectStatus.summary, {
            durationMs: performance.now() - startedAt,
            fields: { repositories: prepared.repositories.length, source },
        });
        const current = this.summaries.get(sessionId);
        return current?.fingerprint === prepared.fingerprint
            ? (current.value ?? prepared.summary)
            : prepared.summary;
    }

    /**
     * Names the Sessions whose delivery status is kept warm in the background (the visible ones; see
     * {@link ResidentPoll}).
     */
    setPolledSessions(sessionIds: ReadonlySet<string>): void {
        this.residentPoll.set(sessionIds);
    }

    /**
     * Re-reads a visible Session's status once the sidebar's pull request sweep saw its pull request change lifecycle
     * (opened, merged, closed). Without it the Status panel kept the pull request open for up to a settled TTL after
     * Caxri had already told the Agent about the merge. Only polled (visible) Sessions are re-read, so a sweep over
     * every Session cannot fan out into `gh` queries for panels nobody renders, and a snapshot that already shows this
     * lifecycle (a focus refresh fetched it first) is left alone. The re-read is a normal stale-while-revalidate load,
     * so it reuses the shared pull request record the sweep just fetched.
     */
    pullRequestChanged(
        sessionId: string,
        pullRequest: Pick<SessionPullRequest, 'state' | 'url'>,
    ): Promise<void> | undefined {
        if (!this.residentPoll.polled.has(sessionId)) return;
        const entry = this.summaries.get(sessionId);
        if (!entry?.value) return;
        const isCurrent = entry.value.repositories.some(
            (repo) =>
                repo.pullRequest?.url === pullRequest.url &&
                repo.pullRequest.lifecycle === pullRequest.state,
        );
        if (isCurrent) return;
        this.rememberSummary(sessionId, { ...entry, expiresAt: 0 });
        return this.rereadSummary(sessionId);
    }

    /**
     * Hands this Service the listener told about each pull request a Session's Status snapshot saw turn merged, in any
     * of its repositories (see `ProjectStatusMergeTracker`). Late-bound like {@link useSessionPullRequests}.
     */
    useMergeListener(listener: (sessionId: string, merge: ProjectStatusMerge) => void): void {
        this.observers.onMerged = listener;
    }

    /**
     * Hands this Service the Session pull request owner. Late-bound because `SessionPullRequestService` is assembled
     * after this Service; until it is set every reader keeps the per-branch lookup.
     */
    useSessionPullRequests(resolver: SessionPullRequestResolver): void {
        this.resolveSessionPullRequest = resolver;
    }

    /**
     * Starts the delivery watch over every Session from {@link ProjectStatusServiceOptions.listWatchedSessions}, so a
     * Session the user switched away from still raises its CI or deployment failure.
     */
    startDeliveryWatch(): void {
        this.watch?.start();
    }

    /**
     * Stops the resident poll. Called when the Server shuts down; the cache and alert baselines die with the process.
     */
    dispose(): void {
        this.watch?.dispose();
        this.commandTelemetry.flush();
        this.residentPoll.dispose();
    }

    /**
     * Prevents a late external refresh from recreating status for a Session that has already been deleted.
     */
    evictSessions(sessionIds: readonly string[]): void {
        for (const sessionId of sessionIds) {
            this.sessionGenerations.delete(sessionId);
            this.summaries.delete(sessionId);
            this.residentPoll.remove(sessionId);
        }
    }

    async summary(sessionId: string, refreshToken?: string): Promise<ProjectStatusSummary> {
        const generation = this.sessionGeneration(sessionId);
        try {
            return await this.requests.run(
                `${sessionId}\0${generation}\0${refreshToken ?? ''}`,
                () => this.loadSummary(sessionId, generation, refreshToken),
            );
        } catch (error) {
            if (this.sessionGenerations.get(sessionId) === generation)
                this.sessionGenerations.delete(sessionId);
            throw error;
        }
    }

    overview(sessionId: string): Promise<ProjectStatusOverview> {
        return this.overviewRequests.run(sessionId, () =>
            loadProjectStatusOverview(
                {
                    acceptance: this.acceptance,
                    git: this.git,
                    github: this.github,
                    ignoredChecks: this.ignoredChecks(),
                    linear: this.linear,
                    logger: this.logger,
                    now: () => this.now(),
                    readGit: this.readGit,
                    remotes: this.remotes,
                    resolver: this.resolveSessionPullRequest,
                    sessionContext: this.options.sessionContext,
                },
                sessionId,
            ),
        );
    }

    /**
     * A linked issue for a hover card, sharing the Status panel's record so hovering an issue the panel already shows
     * spawns nothing. The URL's workspace slug selects the credential, so no Project checkout is needed and the home
     * directory serves as the working directory. The CLI only holds credentials the user stored, so a link in a
     * transcript cannot reach a workspace the user has not signed in to.
     */
    async linearIssue(
        identifier: string,
        workspace: string,
    ): Promise<ProjectStatusLinearIssue | null> {
        try {
            const issue = await this.linear.issue({ cwd: homedir(), identifier, workspace });
            return issue.title === undefined ? null : issue;
        } catch {
            return null;
        }
    }
}
