import { homedir } from 'node:os';

import type {
    GitRepositorySummary as GitRepoSummary,
    ProjectStatusError,
    ProjectStatusLinearIssue,
    ProjectStatusOverview,
    ProjectStatusRepository as ProjectStatusRepo,
    ProjectStatusSummary,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog, SingleFlight } from '@caxri/system';
import { parseGitHubRemote, rememberBounded } from '@caxri/utils';
import { ProjectStatusSummaryErrorMessage as statusError } from 'caxri';

import type { ExternalStatusRunner, ExternalStatusSource } from '../external-status';
import {
    AcceptanceStore,
    ExternalStatusCliError,
    ExternalStatusCommandTelemetry,
    GitHubPullRequestStore,
    isNoPullRequest,
    LinearIssueStore,
    runExternalStatusCommand,
} from '../external-status';
import type { GitService } from '../git';
import type { SessionTranscriptContext } from '../session';
import { loadOverviewAcceptances, loadPullRequestAcceptances } from './acceptance';
import { ProjectStatusAlertTracker } from './alerts';
import type { BranchPublicationContext } from './branch';
import {
    prepareStatusRepo,
    readBranchPublication,
    RemoteHeadCache,
    RepoRemoteCache as RepoRemoteCache,
} from './branch';
import { summaryCacheTtlMs } from './cache-ttl';
import type { PreparedRepo, PreparedSummary, SummaryCacheEntry } from './carry-over';
import { pendingSummaryEntry } from './carry-over';
import { EmptyCheckRollupTracker } from './empty-check-rollup';
import { projectStatusCliError } from './external';
import { emptyGitHubLoad } from './github-load';
import { loadOverviewLinearIssues, loadPullRequestLinearIssues } from './linear';
import type { ProjectStatusClock, ProjectStatusServiceOptions } from './options';
import { projectStatusClock } from './options';
import { parseGitHubPullRequest } from './parse';
import { PullRequestExtras } from './pull-request-extras';
import { refreshLogRecord } from './refresh-log';
import { ResidentPoll } from './resident-poll';
import type { PullRequestTarget, SessionPullRequestResolver } from './session-pull-request';
import {
    loadOverviewPullRequest,
    repoPullRequestNumber,
    resolvePullRequestTarget,
} from './session-pull-request';
import { VercelDeploymentStore } from './vercel-store';
import type { WatchOutcome } from './watch';
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
    private readonly alerts: ProjectStatusAlertTracker;
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
        this.alerts = new ProjectStatusAlertTracker({ now: () => this.now() });
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
                watchSession: (sessionId, covered, isPendingRound) =>
                    this.watchSession(sessionId, covered, isPendingRound),
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

    /**
     * What this Session's own Agent conversation named. Read once per overview and handed to both chips:
     * `SessionContextService` scans incrementally and shares the in-flight read, but asking it twice still costs a
     * second pass over everything the Agent appended.
     */
    private async readConversation(
        sessionId: string,
    ): Promise<SessionTranscriptContext | undefined> {
        try {
            return await this.options.sessionContext?.(sessionId);
        } catch {
            // The conversation is the weakest source either chip has, so an unreadable transcript degrades to "no extra
            // context" rather than failing the overview the status bar draws from.
            return undefined;
        }
    }

    private async loadOverview(sessionId: string): Promise<ProjectStatusOverview> {
        const gitSummary = await this.git.summary(sessionId, 0, 'projectStatus');
        if (!gitSummary.isRepository) {
            return { refreshedAt: this.now(), error: gitSummary.error };
        }
        const repo = gitSummary.repositories.find((candidate) => candidate.kind === 'primary');
        if (!repo) return { refreshedAt: this.now(), error: statusError.missingPrimaryRepository };
        const { remote } = await this.remotes.read(repo.rootPath, this.readGit);
        const github = parseGitHubRemote(remote);
        const githubUrl = github ? `https://github.com/${github.owner}/${github.repo}` : undefined;
        // Independent reads; both usually join the same in-flight transcript pass in `SessionContextService`.
        const [{ pullRequest, pullRequestBody, pullRequestUnavailable }, conversation] =
            await Promise.all([
                (async () => {
                    const target = await resolvePullRequestTarget(
                        this.resolveSessionPullRequest,
                        sessionId,
                    );
                    return loadOverviewPullRequest(this.github, this.logger, {
                        github,
                        repo,
                        target,
                    });
                })(),
                this.readConversation(sessionId),
            ]);
        const [linearIssues, acceptances] = await Promise.all([
            loadOverviewLinearIssues(this.linear, repo.rootPath, {
                branch: repo.branch,
                conversation: conversation?.linearReferences ?? [],
                pullRequestBody,
            }),
            loadOverviewAcceptances(this.acceptance, repo.rootPath, {
                conversation: conversation?.acceptanceReferences ?? [],
                pullRequestBody,
            }),
        ]);
        return {
            repository: {
                id: repo.id,
                branch: repo.branch,
                branchUrl: githubUrl
                    ? `${githubUrl}/tree/${encodeURIComponent(repo.branch)}`
                    : undefined,
                changedFileCount: repo.files.length,
                additions: repo.additions,
                deletions: repo.deletions,
                pullRequest,
                ...(pullRequestUnavailable && { pullRequestUnavailable }),
                linearIssues,
                acceptances,
            },
            refreshedAt: this.now(),
        };
    }

    private async prepareSummary(sessionId: string, isForced = false): Promise<PreparedSummary> {
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
                prepareStatusRepo(repo, this.readGit, this.remotes, isForced),
            ),
        );
        const summary = {
            repositories: repositories.map(({ repository }) => repository),
            refreshedAt: this.now(),
        };
        /**
         * `projectStatus.ignoredChecks` is an input to the rollup rather than a display filter, so a summary computed
         * under superseded rules is wrong the moment the user edits them. Folding the rules into the fingerprint reuses
         * the cache's existing "the inputs changed" path instead of adding a second invalidation mechanism, and the
         * shared pull-request store answers the re-parse from its own record, so the correction normally costs no extra
         * GitHub query.
         */
        const fingerprint = JSON.stringify([
            this.ignoredChecks(),
            repositories.map(({ context, repository }) => [
                repository.id,
                context.branch,
                context.defaultBranch,
                context.head,
                context.owner,
                context.repo,
                context.hasOrigin,
                context.detached,
                context.trackingHead,
            ]),
        ]);
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
                this.extras.attach(cwd, context, parsed.pullRequest, isForced),
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
            const failure =
                error instanceof ExternalStatusCliError
                    ? error
                    : new ExternalStatusCliError('gh', 'other', String(error));
            return {
                ...empty(),
                errors: [projectStatusCliError('gh', failure.kind, { retryAt: failure.retryAt })],
            };
        }
    }

    /**
     * Emits one `projectStatus.alert` per newly failing check or deployment. The tracker is fed even while
     * notifications are disabled so re-enabling them does not replay every failure that accumulated in the meantime as
     * if it had just happened.
     */
    private publishAlerts(sessionId: string, summary: ProjectStatusSummary): void {
        const alerts = this.alerts.observe(summary);
        if (alerts.length === 0 || !this.areAlertsEnabled()) return;
        for (const alert of alerts) {
            this.logger.write('info', logEventCatalog.projectStatus.alert, {
                fields: { kind: alert.kind },
            });
            this.options.emit?.({
                event: 'projectStatus.alert',
                payload: { sessionId, ...alert },
            });
        }
    }

    /**
     * Refreshes one background Session's delivery status unless another Session in this round already covered the same
     * repository and branch. Deduplication runs on the local Git projection, so a Session that has since switched
     * branches is judged by the branch it is on now rather than the one it last reported.
     */
    private async watchSession(
        sessionId: string,
        covered: Set<string>,
        isPendingRound: boolean,
    ): Promise<WatchOutcome> {
        const generation = this.sessionGeneration(sessionId);
        const prepared = await this.prepareSummary(sessionId);
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
                this.publishAlerts(sessionId, value);
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
            // eslint-disable-next-line no-void -- background refresh logs its own failure
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
        return this.overviewRequests.run(sessionId, () => this.loadOverview(sessionId));
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
