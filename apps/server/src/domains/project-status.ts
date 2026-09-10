import { homedir } from 'node:os';

import type {
    AppSettings,
    GitRepositorySummary as GitRepoSummary,
    ProjectStatusError,
    ProjectStatusLinearIssue,
    ProjectStatusOverview,
    ProjectStatusRepository as ProjectStatusRepo,
    ProjectStatusSummary,
    ServerEvent,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';
import { parseGitHubRemote, rememberBounded } from '@caxri/utils';
import { ProjectStatusSummaryErrorMessage as statusError } from 'caxri';

import type { ExternalStatusRunner, ExternalStatusSource } from './external-status';
import {
    ExternalStatusCliError,
    GitHubPullRequestStore,
    isNoPullRequest,
    observeExternalStatusCommand,
    runExternalStatusCommand,
} from './external-status';
import type { GitService } from './git';
import { ProjectStatusAlertTracker } from './project-status-alerts';
import type { VercelLink } from './project-status-external';
import {
    extractLinearReferences,
    projectStatusCliError,
    vcListArguments,
} from './project-status-external';
import {
    githubPullRequestSchema,
    LINEAR_ISSUE_QUERY,
    linearIssueResponseSchema,
    linearStateType,
    parseExternalJson,
    parseGitHubPullRequest,
    parseVercelList,
    vercelTeamListSchema,
} from './project-status-parse';
import { mapProjectStatusDeployment } from './project-status-vercel';
import { SingleFlight } from './single-flight';

export { extractLinearReferences } from './project-status-external';
export { parseGitHubRemote } from '@caxri/utils';

/**
 * Caps the process-lifetime `vercelLinks` cache so long-running sessions can't grow it unbounded.
 */
const VERCEL_LINK_CACHE_LIMIT = 256;
const SUMMARY_CACHE_LIMIT = 128;
/**
 * Cache lifetime adapts to what the snapshot contains, because that is also what paces the resident poller below. A
 * running CI job or an in-flight deployment changes on a scale of tens of seconds and is exactly when the user wants to
 * see movement; a settled pull request will not change until someone pushes, so re-asking every minute only spends the
 * shared `gh`/`vc` budget the limiter is trying to protect.
 */
const SUMMARY_PENDING_CACHE_TTL_MS = 20_000;
const SUMMARY_SETTLED_CACHE_TTL_MS = 120_000;
/**
 * A failed refresh must back off _further_ than a successful one, never less. The previous 30s retried a rate-limited
 * `gh` twice as often as a healthy one, which is how a transient limit turned into a sustained one.
 */
const SUMMARY_FAILURE_CACHE_TTL_MS = 5 * 60_000;
/**
 * Floor and ceiling for the resident poll. The floor keeps a refresh that is still in flight from being re-triggered in
 * a tight loop; the ceiling bounds how long a rate-limit back-off can leave the panel unattended.
 */
const POLL_MIN_DELAY_MS = 15_000;
const POLL_MAX_DELAY_MS = 5 * 60_000;

interface RepoContext {
    branch: string;
    defaultBranch?: string;
    head?: string;
    owner?: string;
    repo?: string;
}

interface PreparedRepo {
    context: RepoContext;
    repository: ProjectStatusRepo;
}

interface PreparedSummary {
    fingerprint?: string;
    repositories: PreparedRepo[];
    summary: ProjectStatusSummary;
}

interface SummaryCacheEntry {
    expiresAt: number;
    fingerprint: string;
    refreshToken?: string;
    value?: ProjectStatusSummary;
}

export interface ProjectStatusServiceOptions {
    cacheLimit?: number;
    cacheTtlMs?: number;
    emit?: (event: ServerEvent) => void;
    failureCacheTtlMs?: number;
    /**
     * Server-wide pull-request projection. Sharing one store with the sidebar sweep and Source Control is what keeps
     * the status bar, the Status panel, and the badges on a single `gh pr view` per pull request.
     */
    github?: GitHubPullRequestStore;
    now?: () => number;
    /**
     * Reads current settings for `projectStatus.ignoredChecks` and `projectStatus.notifications.enabled`. A Server
     * assembled without it behaves as if no check is ignored and no alert is wanted.
     */
    settings?: () => AppSettings;
    /**
     * Injected in tests so a polling interval can be advanced deterministically instead of waited out.
     */
    setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout;
    clearTimer?: (timer: NodeJS.Timeout) => void;
}

export class ProjectStatusService {
    private readonly requests = new SingleFlight<string, ProjectStatusSummary>();
    private readonly overviewRequests = new SingleFlight<string, ProjectStatusOverview>();
    private readonly refreshes = new SingleFlight<string, void>();
    private readonly summaries = new Map<string, SummaryCacheEntry>();
    private readonly sessionGenerations = new Map<string, number>();
    private nextSessionGeneration = 0;
    /**
     * LRU-bounded (see `VERCEL_LINK_CACHE_LIMIT`) so this process-lifetime cache can't grow unbounded.
     */
    private readonly vercelLinks = new Map<string, VercelLink>();
    private readonly github: GitHubPullRequestStore;
    private readonly alerts = new ProjectStatusAlertTracker();
    private polledSessionId?: string;
    private pollTimer?: NodeJS.Timeout;
    private isPollScheduled = false;

    constructor(
        private readonly git: Pick<GitService, 'summary'>,
        private readonly logger: StructuredLogger,
        private readonly runner: ExternalStatusRunner = runExternalStatusCommand,
        private readonly options: ProjectStatusServiceOptions = {},
    ) {
        this.github =
            options.github ?? new GitHubPullRequestStore(this.runner, { now: () => this.now() });
    }

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private ignoredChecks(): readonly string[] {
        return this.options.settings?.()['projectStatus.ignoredChecks'] ?? [];
    }

    private async runCommand(
        command: ExternalStatusSource,
        arguments_: readonly string[],
        cwd: string,
    ): Promise<string> {
        return observeExternalStatusCommand({
            logger: this.logger,
            event: logEventCatalog.projectStatus.cli,
            command,
            arguments: arguments_,
            run: () => this.runner(command, arguments_, cwd),
        });
    }

    private async loadOverview(sessionId: string): Promise<ProjectStatusOverview> {
        const gitSummary = await this.git.summary(sessionId, 0, 'projectStatus');
        if (!gitSummary.isRepository) {
            return { refreshedAt: this.now(), error: gitSummary.error };
        }
        const repo = gitSummary.repositories.find((candidate) => candidate.kind === 'primary');
        if (!repo) return { refreshedAt: this.now(), error: statusError.missingPrimaryRepository };
        const remote = await this.optionalGit(repo.rootPath, ['remote', 'get-url', 'origin']);
        const github = parseGitHubRemote(remote);
        const githubUrl = github ? `https://github.com/${github.owner}/${github.repo}` : undefined;
        let pullRequest: NonNullable<ProjectStatusOverview['repository']>['pullRequest'];
        if (github) {
            try {
                /**
                 * The shared store, not a direct `gh` spawn: the status bar polls every minute and refetches on window
                 * focus, and the Status panel wants the same pull request. One record serves both.
                 */
                const output = await this.github.view({
                    branch: repo.branch,
                    cwd: repo.rootPath,
                    owner: github.owner,
                    repo: github.repo,
                });
                const parsed = output
                    ? parseExternalJson(output, githubPullRequestSchema, 'GitHub pull request')
                    : undefined;
                if (parsed?.number && parsed.title && parsed.url) {
                    pullRequest = {
                        number: parsed.number,
                        title: parsed.title,
                        url: parsed.url,
                    };
                }
            } catch (error) {
                if (!isNoPullRequest(error)) {
                    this.logger.write(
                        'debug',
                        logEventCatalog.projectStatus.overviewGithubUnavailable,
                    );
                }
            }
        }
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
            },
            refreshedAt: this.now(),
        };
    }

    private async prepareSummary(sessionId: string): Promise<PreparedSummary> {
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
            visibleRepositories.map((repo) => this.prepareRepository(repo)),
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
            ]),
        ]);
        this.logger.write('debug', logEventCatalog.projectStatus.local, {
            durationMs: performance.now() - startedAt,
            fields: { repositories: repositories.length },
        });
        return { fingerprint, repositories, summary };
    }

    private async optionalGit(cwd: string, arguments_: readonly string[]): Promise<string> {
        try {
            return (await this.runCommand('git', arguments_, cwd)).trim();
        } catch {
            return '';
        }
    }

    private async prepareRepository(repo: GitRepoSummary): Promise<PreparedRepo> {
        const [remote, defaultBranch, head] = await Promise.all([
            this.optionalGit(repo.rootPath, ['remote', 'get-url', 'origin']),
            this.optionalGit(repo.rootPath, [
                'symbolic-ref',
                '--short',
                'refs/remotes/origin/HEAD',
            ]),
            this.optionalGit(repo.rootPath, ['rev-parse', 'HEAD']),
        ]);
        const github = parseGitHubRemote(remote);
        const context: RepoContext = {
            branch: repo.branch,
            defaultBranch: defaultBranch.replace(/^origin\//, '') || undefined,
            head: head || undefined,
            owner: github?.owner,
            repo: github?.repo,
        };
        const name = context.repo ?? repo.name;
        const githubUrl =
            context.owner && context.repo
                ? `https://github.com/${context.owner}/${context.repo}`
                : undefined;
        return {
            context,
            repository: {
                id: repo.id,
                kind: repo.kind,
                name,
                rootPath: repo.rootPath,
                branch: repo.branch,
                defaultBranch: context.defaultBranch,
                githubUrl,
                branchUrl: githubUrl
                    ? `${githubUrl}/tree/${encodeURIComponent(repo.branch)}`
                    : undefined,
                linearIssues: [],
                errors: [],
            },
        };
    }

    private async refreshRepository(
        prepared: PreparedRepo,
        isForced: boolean,
    ): Promise<ProjectStatusRepo> {
        const [githubState, vercelState] = await Promise.all([
            this.loadGitHub(prepared.repository.rootPath, prepared.context, isForced),
            this.loadVercel(prepared.context),
        ]);
        return {
            ...prepared.repository,
            pullRequest: githubState.pullRequest,
            linearIssues: githubState.linearIssues,
            deployments: vercelState.deployments,
            errors: [...githubState.errors, ...vercelState.errors],
        };
    }

    private async loadGitHub(
        cwd: string,
        context: RepoContext,
        isForced: boolean,
    ): Promise<
        Pick<ProjectStatusRepo, 'pullRequest' | 'linearIssues'> & {
            errors: ProjectStatusError[];
        }
    > {
        if (!context.owner || !context.repo || !context.branch) {
            return { linearIssues: [], errors: [] };
        }
        try {
            const output = await this.github.view({
                branch: context.branch,
                cwd,
                // An explicit user refresh must reach GitHub; an automatic revalidation may reuse the shared record.
                maxAgeMs: isForced ? 0 : undefined,
                owner: context.owner,
                repo: context.repo,
            });
            if (!output) return { linearIssues: [], errors: [] };
            const parsed = parseGitHubPullRequest(output, this.ignoredChecks());
            const linear = await this.loadLinear(cwd, parsed.body);
            return {
                pullRequest: parsed.pullRequest,
                linearIssues: linear.issues,
                errors: linear.error ? [linear.error] : [],
            };
        } catch (error) {
            if (isNoPullRequest(error)) return { linearIssues: [], errors: [] };
            const failure =
                error instanceof ExternalStatusCliError
                    ? error
                    : new ExternalStatusCliError('gh', 'other', String(error));
            return { linearIssues: [], errors: [projectStatusCliError('gh', failure.kind)] };
        }
    }

    private async loadLinear(
        cwd: string,
        body: string,
    ): Promise<{ issues: ProjectStatusLinearIssue[]; error?: ProjectStatusError }> {
        const references = extractLinearReferences(body);
        if (references.length === 0) return { issues: [] };
        let firstError: ProjectStatusError | undefined;
        const issues = await Promise.all(
            references.map(async (reference): Promise<ProjectStatusLinearIssue> => {
                try {
                    const arguments_ = [
                        'api',
                        LINEAR_ISSUE_QUERY,
                        '--variable',
                        `id=${reference.identifier}`,
                    ];
                    if (reference.workspace) arguments_.push('--workspace', reference.workspace);
                    const raw = parseExternalJson(
                        await this.runCommand('linear', arguments_, cwd),
                        linearIssueResponseSchema,
                        'Linear issue',
                    );
                    const issue = raw.data?.issue;
                    return {
                        identifier: issue?.identifier ?? reference.identifier,
                        title: issue?.title,
                        url: issue?.url,
                        state: issue?.state?.name,
                        stateType: linearStateType(issue?.state?.type),
                    };
                } catch (error) {
                    const failure =
                        error instanceof ExternalStatusCliError
                            ? error
                            : new ExternalStatusCliError('linear', 'other', String(error));
                    firstError ??= projectStatusCliError('linear', failure.kind);
                    return { identifier: reference.identifier };
                }
            }),
        );
        return { issues, error: firstError };
    }

    private async findVercelLink(owner: string, repo: string): Promise<VercelLink | undefined> {
        const key = `${owner}/${repo}`;
        const cached = this.vercelLinks.get(key);
        if (cached) {
            rememberBounded(this.vercelLinks, key, cached, VERCEL_LINK_CACHE_LIMIT);
            return cached;
        }
        const teamsJson = await this.runCommand(
            'vc',
            ['teams', 'ls', '--format', 'json'],
            homedir(),
        );
        const parsed = parseExternalJson(teamsJson, vercelTeamListSchema, 'Vercel team list');
        const teams = (Array.isArray(parsed) ? parsed : (parsed.teams ?? [])).flatMap((team) =>
            team.slug ? [team.slug] : [],
        );
        const links = await Promise.all(
            teams.map(async (team): Promise<VercelLink | undefined> => {
                const output = await this.runCommand(
                    'vc',
                    vcListArguments(team, { githubOrg: owner, githubRepo: repo }),
                    homedir(),
                );
                const project = parseVercelList(output)[0]?.name;
                return project ? { team, project } : undefined;
            }),
        );
        const link = links.find((candidate): candidate is VercelLink => Boolean(candidate));
        if (link) rememberBounded(this.vercelLinks, key, link, VERCEL_LINK_CACHE_LIMIT);
        return link;
    }

    private async loadVercel(
        context: RepoContext,
    ): Promise<Pick<ProjectStatusRepo, 'deployments'> & { errors: ProjectStatusError[] }> {
        if (!context.owner || !context.repo) return { errors: [] };
        try {
            const link = await this.findVercelLink(context.owner, context.repo);
            if (!link) return { errors: [] };
            const baseMeta = { githubOrg: context.owner, githubRepo: context.repo };
            const results = await Promise.all([
                this.runCommand(
                    'vc',
                    vcListArguments(link.team, { ...baseMeta, githubCommitRef: context.branch }),
                    homedir(),
                ),
                this.runCommand(
                    'vc',
                    vcListArguments(link.team, baseMeta, 'production'),
                    homedir(),
                ),
                context.head
                    ? this.runCommand(
                          'vc',
                          vcListArguments(link.team, { githubCommitSha: context.head }, 'preview'),
                          homedir(),
                      )
                    : Promise.resolve('[]'),
            ]);
            const branchDeployments = parseVercelList(results[0])
                .slice(0, 10)
                .flatMap((deployment) => {
                    const mapped = mapProjectStatusDeployment(deployment, undefined, link);
                    return mapped ? [mapped] : [];
                });
            const production = mapProjectStatusDeployment(
                parseVercelList(results[1])[0] ?? {},
                'production',
                link,
            );
            const preview = mapProjectStatusDeployment(
                parseVercelList(results[2])[0] ?? {},
                'preview',
                link,
            );
            return {
                deployments: {
                    url: `https://vercel.com/${link.team}/${link.project}/deployments?filterBranch=${encodeURIComponent(context.branch)}`,
                    branchDeployments,
                    production,
                    preview,
                },
                errors: [],
            };
        } catch (error) {
            const failure =
                error instanceof ExternalStatusCliError
                    ? error
                    : new ExternalStatusCliError('vc', 'other', String(error));
            return { errors: [projectStatusCliError('vc', failure.kind)] };
        }
    }

    /**
     * How long this snapshot stays authoritative. An explicit `cacheTtlMs` (tests, and callers that need a fixed
     * window) wins; otherwise the presence of anything still running decides.
     */
    private summaryCacheTtlMs(summary: ProjectStatusSummary, hasFailures: boolean): number {
        if (hasFailures) return this.options.failureCacheTtlMs ?? SUMMARY_FAILURE_CACHE_TTL_MS;
        if (this.options.cacheTtlMs !== undefined) return this.options.cacheTtlMs;
        const isPending = summary.repositories.some(
            (repo) =>
                repo.pullRequest?.state === 'pending' ||
                repo.deployments?.production?.state === 'pending' ||
                repo.deployments?.preview?.state === 'pending',
        );
        return isPending ? SUMMARY_PENDING_CACHE_TTL_MS : SUMMARY_SETTLED_CACHE_TTL_MS;
    }

    /**
     * Emits one `projectStatus.alert` per newly failing check or deployment. The tracker is fed even while
     * notifications are disabled so re-enabling them does not replay every failure that accumulated in the meantime as
     * if it had just happened.
     */
    private publishAlerts(sessionId: string, summary: ProjectStatusSummary): void {
        const alerts = this.alerts.observe(summary);
        if (alerts.length === 0) return;
        if (this.options.settings?.()['projectStatus.notifications.enabled'] !== true) return;
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

    private setTimer(callback: () => void, delayMs: number): NodeJS.Timeout {
        return this.options.setTimer?.(callback, delayMs) ?? setTimeout(callback, delayMs);
    }

    private clearTimer(timer: NodeJS.Timeout): void {
        if (this.options.clearTimer) this.options.clearTimer(timer);
        else clearTimeout(timer);
    }

    /**
     * Arms the next resident refresh for the polled Session against its cache expiry, so a snapshot with a running job
     * is revisited sooner than a settled one and a rate-limited source is left alone.
     */
    private schedulePoll(): void {
        if (this.pollTimer) {
            this.clearTimer(this.pollTimer);
            this.pollTimer = undefined;
        }
        const sessionId = this.polledSessionId;
        if (!sessionId) return;
        const expiresAt = this.summaries.get(sessionId)?.expiresAt ?? 0;
        const delayMs = Math.min(
            Math.max(expiresAt - this.now(), POLL_MIN_DELAY_MS),
            POLL_MAX_DELAY_MS,
        );
        const timer = this.setTimer(() => {
            this.pollTimer = undefined;
            // Fire-and-forget: `runPoll` owns its own failure logging and re-arms the timer either way.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void this.runPoll(sessionId);
        }, delayMs);
        // Never hold the Server process open for a background refresh.
        timer.unref();
        this.pollTimer = timer;
    }

    private async runPoll(sessionId: string): Promise<void> {
        if (this.isPollScheduled || this.polledSessionId !== sessionId) return;
        this.isPollScheduled = true;
        const startedAt = performance.now();
        try {
            await this.summary(sessionId);
            this.logger.write('debug', logEventCatalog.projectStatus.poll, {
                durationMs: performance.now() - startedAt,
                fields: { result: 'success' },
            });
        } catch (error) {
            this.logger.write('debug', logEventCatalog.projectStatus.poll, {
                durationMs: performance.now() - startedAt,
                fields: {
                    result: 'failure',
                    code: error instanceof CaxriError ? error.code : 'INTERNAL',
                },
            });
        } finally {
            this.isPollScheduled = false;
            if (this.polledSessionId === sessionId) this.schedulePoll();
        }
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
                const repositories = await Promise.all(
                    prepared.repositories.map((repo) => this.refreshRepository(repo, isForced)),
                );
                if (
                    this.sessionGenerations.get(sessionId) !== sessionGeneration ||
                    this.summaries.get(sessionId)?.fingerprint !== fingerprint
                )
                    return;
                const value = { repositories, refreshedAt: this.now() };
                const hasFailures = repositories.some((repo) => repo.errors.length > 0);
                const ttl = this.summaryCacheTtlMs(value, hasFailures);
                this.rememberSummary(sessionId, {
                    expiresAt: this.now() + ttl,
                    fingerprint,
                    refreshToken: this.summaries.get(sessionId)?.refreshToken,
                    value,
                });
                this.logger.write(
                    hasFailures ? 'warn' : 'info',
                    logEventCatalog.projectStatus.refresh,
                    {
                        durationMs: performance.now() - startedAt,
                        fields: {
                            repositories: repositories.length,
                            result: hasFailures ? 'failure' : 'success',
                            ttlMs: ttl,
                        },
                    },
                );
                this.publishAlerts(sessionId, value);
                this.options.emit?.({ event: 'projectStatus.changed', payload: { sessionId } });
                // The fresh TTL is what paces the next resident poll, so re-arm against it rather than the stale one.
                this.schedulePoll();
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
        const prepared = await this.prepareSummary(sessionId);
        if (this.sessionGenerations.get(sessionId) !== sessionGeneration) return prepared.summary;
        if (!prepared.fingerprint) {
            this.sessionGenerations.delete(sessionId);
            this.summaries.delete(sessionId);
            return prepared.summary;
        }
        let cached = this.summaries.get(sessionId);
        if (cached?.fingerprint !== prepared.fingerprint) {
            cached = { expiresAt: 0, fingerprint: prepared.fingerprint, refreshToken };
            this.rememberSummary(sessionId, cached);
        }
        const isForceRefresh = refreshToken !== undefined && cached.refreshToken !== refreshToken;
        if (isForceRefresh) cached = { ...cached, refreshToken };
        this.rememberSummary(sessionId, cached);
        const source = cached.value ? (cached.expiresAt > this.now() ? 'fresh' : 'stale') : 'local';
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
     * Names the Session whose delivery status is kept warm in the background. Only the selected Session is polled: it
     * is the one the Status panel will render, and every extra repository costs another `gh`/`vc` round trip against a
     * budget shared with the user's own shell.
     */
    setPolledSession(sessionId: string | undefined): void {
        if (this.polledSessionId === sessionId) return;
        this.polledSessionId = sessionId;
        this.schedulePoll();
    }

    /**
     * Stops the resident poll. Called when the Server shuts down; the cache and alert baselines die with the process.
     */
    dispose(): void {
        this.polledSessionId = undefined;
        if (!this.pollTimer) return;
        this.clearTimer(this.pollTimer);
        this.pollTimer = undefined;
    }

    /**
     * Prevents a late external refresh from recreating status for a Session that has already been deleted.
     */
    evictSessions(sessionIds: readonly string[]): void {
        for (const sessionId of sessionIds) {
            this.sessionGenerations.delete(sessionId);
            this.summaries.delete(sessionId);
            // A deleted Session must not keep a background `gh`/`vc` refresh alive on its behalf.
            if (this.polledSessionId === sessionId) this.setPolledSession(undefined);
        }
    }

    async summary(sessionId: string, refreshToken?: string): Promise<ProjectStatusSummary> {
        let generation = this.sessionGenerations.get(sessionId);
        if (generation === undefined) {
            generation = ++this.nextSessionGeneration;
            this.sessionGenerations.set(sessionId, generation);
        }
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
}
