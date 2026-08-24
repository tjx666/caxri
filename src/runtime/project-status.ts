import { homedir } from 'node:os';

import { z } from 'zod';

import { CaxriError } from '../shared/ipc/errors';
import type { RuntimeEvent } from '../shared/ipc/events';
import type { StructuredLogger } from '../shared/node/logger';
import { logEventCatalog } from '../shared/node/logger';
import type {
    GitRepositorySummary as GitRepoSummary,
    ProjectStatusCheck,
    ProjectStatusDeployment,
    ProjectStatusError,
    ProjectStatusLinearIssue,
    ProjectStatusOverview,
    ProjectStatusRepository as ProjectStatusRepo,
    ProjectStatusState,
    ProjectStatusSummary,
} from '../shared/types';
import type { GitService } from './git';
import type {
    ProjectStatusCommand,
    ProjectStatusRunner,
    VercelLink,
} from './project-status-external';
import {
    extractLinearReferences,
    isNoPullRequest,
    parseGitHubRemote,
    ProjectStatusCliError,
    projectStatusCliError,
    projectStatusCommandOperation,
    rememberVercelLink,
    runProjectStatusCommand,
    vcListArguments,
} from './project-status-external';
import { SingleFlight } from './single-flight';

export { extractLinearReferences, parseGitHubRemote } from './project-status-external';

/**
 * Caps the process-lifetime `vercelLinks` cache so long-running sessions can't grow it unbounded.
 */
const VERCEL_LINK_CACHE_LIMIT = 256;
const SUMMARY_CACHE_LIMIT = 128;
const SUMMARY_CACHE_TTL_MS = 60_000;
const SUMMARY_FAILURE_CACHE_TTL_MS = 30_000;

const githubCheckSchema = z.object({
    __typename: z.string().optional(),
    completedAt: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    context: z.string().optional(),
    detailsUrl: z.string().optional(),
    name: z.string().optional(),
    startedAt: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    targetUrl: z.string().optional(),
    workflowName: z.string().optional(),
});

type GitHubCheck = z.infer<typeof githubCheckSchema>;

const githubPullRequestSchema = z.object({
    body: z.string().optional(),
    number: z.number().int().positive().optional(),
    statusCheckRollup: z.array(githubCheckSchema).optional(),
    title: z.string().min(1).optional(),
    url: z.string().optional(),
});

const vercelDeploymentSchema = z.object({
    created: z.number().optional(),
    name: z.string().optional(),
    readyState: z.string().optional(),
    state: z.string().optional(),
    target: z.enum(['production', 'preview']).nullable().optional(),
    url: z.string().optional(),
});

type VercelDeployment = z.infer<typeof vercelDeploymentSchema>;

const vercelDeploymentListSchema = z.union([
    z.array(vercelDeploymentSchema),
    z.object({ deployments: z.array(vercelDeploymentSchema).optional() }),
]);

const vercelTeamSchema = z.object({ slug: z.string().optional() });

const vercelTeamListSchema = z.union([
    z.array(vercelTeamSchema),
    z.object({ teams: z.array(vercelTeamSchema).optional() }),
]);

const linearIssueStateSchema = z.object({
    name: z.string().optional(),
    type: z.string().optional(),
});

const linearIssueSchema = z.object({
    identifier: z.string().optional(),
    title: z.string().optional(),
    url: z.string().optional(),
    state: linearIssueStateSchema.optional(),
});

const linearIssueDataSchema = z.object({
    issue: linearIssueSchema.optional(),
});

const linearIssueResponseSchema = z.object({
    data: linearIssueDataSchema.optional(),
});

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
    emit?: (event: RuntimeEvent) => void;
    failureCacheTtlMs?: number;
    now?: () => number;
}

const LINEAR_STATE_TYPES = new Set<ProjectStatusLinearIssue['stateType']>([
    'backlog',
    'canceled',
    'completed',
    'duplicate',
    'started',
    'triage',
    'unstarted',
]);

function linearStateType(value: string | undefined): ProjectStatusLinearIssue['stateType'] {
    return LINEAR_STATE_TYPES.has(value as ProjectStatusLinearIssue['stateType'])
        ? (value as ProjectStatusLinearIssue['stateType'])
        : undefined;
}

const SUCCESS_RESULTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED']);
const FAILURE_RESULTS = new Set([
    'FAILURE',
    'FAILED',
    'CANCELLED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'ERROR',
]);
const PENDING_RESULTS = new Set(['IN_PROGRESS', 'QUEUED', 'PENDING', 'EXPECTED']);
const LINEAR_ISSUE_QUERY = `query IssueStatus($id:String!){
  issue(id:$id){identifier title url state{name type}}
}`;

function parseExternalJson<T>(value: string, schema: z.ZodType<T>, label: string): T {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        throw new CaxriError('VALIDATION', `Invalid ${label} JSON`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) throw new CaxriError('VALIDATION', `Invalid ${label} payload`);
    return result.data;
}

function checkState(check: GitHubCheck): ProjectStatusState {
    const status = (check.status ?? '').toUpperCase();
    const result = (check.conclusion ?? check.state ?? '').toUpperCase();
    if (PENDING_RESULTS.has(status) || PENDING_RESULTS.has(result)) return 'pending';
    if (FAILURE_RESULTS.has(result)) return 'failure';
    if (SUCCESS_RESULTS.has(result)) return 'success';
    return 'neutral';
}

function aggregateChecks(checks: ProjectStatusCheck[]): ProjectStatusState {
    if (checks.some((check) => check.state === 'failure')) return 'failure';
    if (checks.length === 0 || checks.some((check) => check.state === 'pending')) return 'pending';
    return 'success';
}

function checkDuration(check: GitHubCheck): number | undefined {
    if (!check.startedAt || !check.completedAt) return undefined;
    const duration = Date.parse(check.completedAt) - Date.parse(check.startedAt);
    return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

export function parseGitHubPullRequest(value: string): {
    body: string;
    pullRequest?: ProjectStatusRepo['pullRequest'];
} {
    const raw = parseExternalJson(value, githubPullRequestSchema, 'GitHub pull request');
    if (!raw.number || !raw.title || !raw.url) return { body: raw.body ?? '' };
    const checks = (raw.statusCheckRollup ?? []).map((check): ProjectStatusCheck => ({
        name: check.workflowName
            ? `${check.workflowName} / ${check.name ?? check.context ?? '?'}`
            : (check.name ?? check.context ?? '?'),
        state: checkState(check),
        url: check.detailsUrl ?? check.targetUrl,
        durationMs: checkDuration(check),
    }));
    checks.sort(
        (a, b) =>
            ['failure', 'pending', 'success', 'neutral'].indexOf(a.state) -
            ['failure', 'pending', 'success', 'neutral'].indexOf(b.state),
    );
    return {
        body: raw.body ?? '',
        pullRequest: {
            number: raw.number,
            title: raw.title,
            url: raw.url,
            state: aggregateChecks(checks),
            checks,
            hiddenCheckCount: 0,
        },
    };
}

function deploymentState(deployment: VercelDeployment): ProjectStatusState {
    const state = (deployment.readyState ?? deployment.state ?? '').toUpperCase();
    if (state === 'READY') return 'success';
    if (state === 'ERROR') return 'failure';
    if (['BUILDING', 'QUEUED', 'INITIALIZING'].includes(state)) return 'pending';
    return state === 'CANCELED' ? 'neutral' : 'unknown';
}

function mapDeployment(
    deployment: VercelDeployment,
    environment: ProjectStatusDeployment['environment'] = deployment.target === 'production'
        ? 'production'
        : 'preview',
): ProjectStatusDeployment | undefined {
    if (!deployment.url) return undefined;
    const hostname = deployment.url.replace(/^https?:\/\//, '');
    return {
        environment,
        hostname,
        state: deploymentState(deployment),
        url: `https://${hostname}`,
        createdAt: deployment.created,
    };
}

function parseVercelList(value: string): VercelDeployment[] {
    const parsed = parseExternalJson(value, vercelDeploymentListSchema, 'Vercel deployment list');
    const deployments = Array.isArray(parsed) ? parsed : (parsed.deployments ?? []);
    return deployments.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0));
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

    constructor(
        private readonly git: Pick<GitService, 'summary'>,
        private readonly logger: StructuredLogger,
        private readonly runner: ProjectStatusRunner = runProjectStatusCommand,
        private readonly options: ProjectStatusServiceOptions = {},
    ) {}

    private now(): number {
        return this.options.now?.() ?? Date.now();
    }

    private async runCommand(
        command: ProjectStatusCommand,
        arguments_: readonly string[],
        cwd: string,
    ): Promise<string> {
        const startedAt = performance.now();
        const operation = projectStatusCommandOperation(command, arguments_);
        try {
            const result = await this.runner(command, arguments_, cwd);
            this.logger.write('debug', logEventCatalog.projectStatus.cli, {
                durationMs: performance.now() - startedAt,
                fields: { command, operation, result: 'success' },
            });
            return result;
        } catch (error) {
            const failureKind =
                error instanceof ProjectStatusCliError ? error.kind : ('other' as const);
            this.logger.write(
                isNoPullRequest(error) ? 'debug' : 'warn',
                logEventCatalog.projectStatus.cli,
                {
                    durationMs: performance.now() - startedAt,
                    fields: { command, operation, result: 'failure', failureKind },
                },
            );
            throw error;
        }
    }

    private async loadOverview(sessionId: string): Promise<ProjectStatusOverview> {
        const gitSummary = await this.git.summary(sessionId);
        if (!gitSummary.isRepository) {
            return { refreshedAt: this.now(), error: gitSummary.error };
        }
        const repo = gitSummary.repositories.find((candidate) => candidate.kind === 'primary');
        if (!repo) return { refreshedAt: this.now(), error: 'No primary repository found.' };
        const remote = await this.optionalGit(repo.rootPath, ['remote', 'get-url', 'origin']);
        const github = parseGitHubRemote(remote);
        const githubUrl = github ? `https://github.com/${github.owner}/${github.repo}` : undefined;
        let pullRequest: NonNullable<ProjectStatusOverview['repository']>['pullRequest'];
        if (github) {
            try {
                const output = await this.runCommand(
                    'gh',
                    [
                        'pr',
                        'view',
                        repo.branch,
                        '--repo',
                        `${github.owner}/${github.repo}`,
                        '--json',
                        'number,title,url',
                    ],
                    repo.rootPath,
                );
                const parsed = parseExternalJson(
                    output,
                    githubPullRequestSchema,
                    'GitHub pull request',
                );
                if (parsed.number && parsed.title && parsed.url) {
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
        const gitSummary = await this.git.summary(sessionId);
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
        const fingerprint = JSON.stringify(
            repositories.map(({ context, repository }) => [
                repository.id,
                context.branch,
                context.defaultBranch,
                context.head,
                context.owner,
                context.repo,
            ]),
        );
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

    private async refreshRepository(prepared: PreparedRepo): Promise<ProjectStatusRepo> {
        const [githubState, vercelState] = await Promise.all([
            this.loadGitHub(prepared.repository.rootPath, prepared.context),
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
    ): Promise<
        Pick<ProjectStatusRepo, 'pullRequest' | 'linearIssues'> & {
            errors: ProjectStatusError[];
        }
    > {
        if (!context.owner || !context.repo || !context.branch) {
            return { linearIssues: [], errors: [] };
        }
        try {
            const output = await this.runCommand(
                'gh',
                [
                    'pr',
                    'view',
                    context.branch,
                    '--repo',
                    `${context.owner}/${context.repo}`,
                    '--json',
                    'number,title,url,body,statusCheckRollup',
                ],
                cwd,
            );
            const parsed = parseGitHubPullRequest(output);
            const linear = await this.loadLinear(cwd, parsed.body);
            return {
                pullRequest: parsed.pullRequest,
                linearIssues: linear.issues,
                errors: linear.error ? [linear.error] : [],
            };
        } catch (error) {
            if (isNoPullRequest(error)) return { linearIssues: [], errors: [] };
            const failure =
                error instanceof ProjectStatusCliError
                    ? error
                    : new ProjectStatusCliError('gh', 'other', String(error));
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
                        error instanceof ProjectStatusCliError
                            ? error
                            : new ProjectStatusCliError('linear', 'other', String(error));
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
            rememberVercelLink(this.vercelLinks, key, cached, VERCEL_LINK_CACHE_LIMIT);
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
        if (link) rememberVercelLink(this.vercelLinks, key, link, VERCEL_LINK_CACHE_LIMIT);
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
                    const mapped = mapDeployment(deployment);
                    return mapped ? [mapped] : [];
                });
            const production = mapDeployment(parseVercelList(results[1])[0] ?? {}, 'production');
            const preview = mapDeployment(parseVercelList(results[2])[0] ?? {}, 'preview');
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
                error instanceof ProjectStatusCliError
                    ? error
                    : new ProjectStatusCliError('vc', 'other', String(error));
            return { errors: [projectStatusCliError('vc', failure.kind)] };
        }
    }

    private rememberSummary(sessionId: string, entry: SummaryCacheEntry): void {
        this.summaries.delete(sessionId);
        this.summaries.set(sessionId, entry);
        const maximum = this.options.cacheLimit ?? SUMMARY_CACHE_LIMIT;
        while (this.summaries.size > Math.max(1, maximum)) {
            const oldest = this.summaries.keys().next().value;
            if (!oldest) break;
            this.summaries.delete(oldest);
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
    ): Promise<void> {
        const fingerprint = prepared.fingerprint;
        if (!fingerprint || this.sessionGenerations.get(sessionId) !== sessionGeneration) return;
        const refreshKey = `${sessionId}\0${sessionGeneration}\0${fingerprint}`;
        try {
            await this.refreshes.run(refreshKey, async () => {
                const startedAt = performance.now();
                const repositories = await Promise.all(
                    prepared.repositories.map((repo) => this.refreshRepository(repo)),
                );
                if (
                    this.sessionGenerations.get(sessionId) !== sessionGeneration ||
                    this.summaries.get(sessionId)?.fingerprint !== fingerprint
                )
                    return;
                const value = { repositories, refreshedAt: this.now() };
                const hasFailures = repositories.some((repo) => repo.errors.length > 0);
                const ttl = hasFailures
                    ? (this.options.failureCacheTtlMs ?? SUMMARY_FAILURE_CACHE_TTL_MS)
                    : (this.options.cacheTtlMs ?? SUMMARY_CACHE_TTL_MS);
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
                        },
                    },
                );
                this.options.emit?.({ event: 'projectStatus.changed', payload: { sessionId } });
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
        if (isForceRefresh) await this.refreshSummary(sessionId, prepared, sessionGeneration);
        else if (source !== 'fresh') {
            // The cache event owns UI convergence for automatic stale-while-revalidate loads.
            // eslint-disable-next-line no-void -- background refresh logs its own failure
            void this.refreshSummary(sessionId, prepared, sessionGeneration);
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
     * Prevents a late external refresh from recreating status for a Session that has already been deleted.
     */
    evictSessions(sessionIds: readonly string[]): void {
        for (const sessionId of sessionIds) {
            this.sessionGenerations.delete(sessionId);
            this.summaries.delete(sessionId);
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
