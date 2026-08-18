import { homedir } from 'node:os';

import { z } from 'zod';

import { CaxriError } from '../shared/ipc/errors';
import { execFileAsync } from '../shared/node/exec';
import type { StructuredLogger } from '../shared/node/logger';
import { safeProcessEnvironment } from '../shared/node/process-environment';
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
import type { ExternalCommandDependencies } from './executables';
import { runExternalCommand } from './executables';
import type { GitService } from './git';
import { SingleFlight } from './single-flight';

const CLI_TIMEOUT_MS = 8_000;
const CLI_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/**
 * Caps the process-lifetime `vercelLinks` cache so long-running sessions can't grow it unbounded.
 */
const VERCEL_LINK_CACHE_LIMIT = 256;

type ProjectStatusCommand = 'gh' | 'git' | 'linear' | 'vc';
type CliFailureKind =
    'not-found' | 'not-logged-in' | 'not-linked' | 'rate-limited' | 'timeout' | 'other';

export type ProjectStatusRunner = (
    command: ProjectStatusCommand,
    arguments_: readonly string[],
    cwd: string,
) => Promise<string>;

export type ProjectStatusCommandDependencies = ExternalCommandDependencies;

class ProjectStatusCliError extends Error {
    constructor(
        readonly command: ProjectStatusCommand,
        readonly kind: CliFailureKind,
        message: string,
    ) {
        super(message);
    }
}

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

export interface VercelLink {
    project: string;
    team: string;
}

interface LinearReference {
    identifier: string;
    workspace?: string;
}

interface RepoContext {
    branch: string;
    defaultBranch?: string;
    head?: string;
    owner?: string;
    repo?: string;
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
const REFERENCE_MARKERS = [
    'Fix',
    'Fixes',
    'Fixed',
    'Close',
    'Closes',
    'Closed',
    'Resolve',
    'Resolves',
    'Resolved',
    'Related to',
] as const;
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

function classifyCliFailure(
    // Deliberately not `NodeJS.ErrnoException` here: that type inherits `Error`'s required
    // `message: string`, but callers pass a plain `error as {...}` cast over an `unknown` catch
    // value, which is not guaranteed to be an `Error` instance with a `message` at runtime.
    error: { code?: string; killed?: boolean; message?: string; stderr?: string },
): CliFailureKind {
    if (error.code === 'ENOENT') return 'not-found';
    const stderr = error.stderr ?? error.message ?? '';
    if (error.killed || /timed out/i.test(stderr)) return 'timeout';
    if (/rate limit|abuse detection/i.test(stderr)) return 'rate-limited';
    if (
        /auth(?:entication)? required|auth login|not logged in|login required|no api key/i.test(
            stderr,
        )
    ) {
        return 'not-logged-in';
    }
    if (/not linked|no project|run.*link|link this directory|not configured/i.test(stderr)) {
        return 'not-linked';
    }
    return 'other';
}

function cliError(command: ProjectStatusCommand, kind: CliFailureKind): ProjectStatusError {
    const source = command === 'gh' ? 'github' : command === 'vc' ? 'vercel' : 'linear';
    const cli = command;
    if (kind === 'not-found') {
        return {
            source,
            message: `${cli} not installed`,
            hint:
                command === 'gh'
                    ? 'Install GitHub CLI to load pull requests.'
                    : command === 'vc'
                      ? 'Install Vercel CLI to load deployments.'
                      : 'Install linear-cli to load linked issues.',
        };
    }
    if (kind === 'not-logged-in') {
        return {
            source,
            message: `${cli}: not logged in`,
            hint: `Run \`${cli} ${command === 'vc' ? 'login' : 'auth login'}\` in a Terminal.`,
        };
    }
    if (kind === 'not-linked') {
        return {
            source,
            message: `${cli}: not linked`,
            hint:
                command === 'vc'
                    ? 'Run `vc link` in the repository.'
                    : 'Run `linear config` in the repository.',
        };
    }
    if (kind === 'rate-limited') {
        return {
            source,
            message: `${cli}: rate limited`,
            hint: 'Refresh after the API limit resets.',
        };
    }
    if (kind === 'timeout') {
        return {
            source,
            message: `${cli} timed out`,
            hint: 'Check the network or proxy, then refresh.',
        };
    }
    return { source, message: `${cli}: error`, hint: 'See Runtime logs for details.' };
}

function isNoPullRequest(error: unknown): boolean {
    return (
        error instanceof Error &&
        /no pull requests found|could not find pull request/i.test(error.message)
    );
}

export function parseGitHubRemote(value: string): { owner: string; repo: string } | undefined {
    const match = value
        .trim()
        .replace(/\/$/, '')
        .replace(/\.git$/, '')
        .match(/github\.com[:/]([^/\s]+)\/([^/\s]+)$/i);
    return match ? { owner: match[1], repo: match[2] } : undefined;
}

export function extractLinearReferences(body: string): LinearReference[] {
    const references: LinearReference[] = [];
    const add = (identifier: string, workspace?: string): void => {
        const normalized = identifier.toUpperCase();
        if (references.some((candidate) => candidate.identifier === normalized)) return;
        references.push({ identifier: normalized, workspace: workspace?.toLowerCase() });
    };
    for (const match of body.matchAll(
        /https?:\/\/linear\.app\/([a-z0-9-]+)\/issue\/([a-z][a-z0-9]*-[1-9]\d*)/giu,
    )) {
        add(match[2], match[1]);
    }
    const markerPattern = REFERENCE_MARKERS.map((marker) =>
        marker.replaceAll(' ', String.raw`\s+`),
    ).join('|');
    const referenceLine = new RegExp(String.raw`(?:^|\b)(?:${markerPattern})\b([^\n]*)`, 'giu');
    for (const marker of body.matchAll(referenceLine)) {
        const identifiers = marker[1].matchAll(/\b([a-z][a-z0-9]*-[1-9]\d*)\b/giu);
        for (const identifier of identifiers) {
            add(identifier[1]);
        }
    }
    return references;
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

/**
 * Inserts into the LRU-bounded `vercelLinks` cache, evicting the oldest entry once over capacity. Mirrors the eviction
 * pattern used by `files/watcher.ts`'s `rememberPolledDirectory`/ `rememberChangeFingerprint`: re-inserting a key
 * refreshes its recency, and eviction removes the least-recently-used entry (the `Map` iteration order's first key).
 */
export function rememberVercelLink(
    links: Map<string, VercelLink>,
    key: string,
    value: VercelLink,
    maximum: number,
): void {
    links.delete(key);
    links.set(key, value);
    while (links.size > Math.max(1, maximum)) {
        const oldest = links.keys().next().value;
        if (!oldest) break;
        links.delete(oldest);
    }
}

function parseVercelList(value: string): VercelDeployment[] {
    const parsed = parseExternalJson(value, vercelDeploymentListSchema, 'Vercel deployment list');
    const deployments = Array.isArray(parsed) ? parsed : (parsed.deployments ?? []);
    return deployments.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

export class ProjectStatusService {
    private readonly requests = new SingleFlight<string, ProjectStatusSummary>();
    private readonly overviewRequests = new SingleFlight<string, ProjectStatusOverview>();
    /**
     * LRU-bounded (see `VERCEL_LINK_CACHE_LIMIT`) so this process-lifetime cache can't grow unbounded.
     */
    private readonly vercelLinks = new Map<string, VercelLink>();

    constructor(
        private readonly git: Pick<GitService, 'summary'>,
        private readonly logger: StructuredLogger,
        private readonly runner: ProjectStatusRunner = runProjectStatusCommand,
    ) {}

    private async loadOverview(sessionId: string): Promise<ProjectStatusOverview> {
        const gitSummary = await this.git.summary(sessionId);
        if (!gitSummary.isRepository) {
            return { refreshedAt: Date.now(), error: gitSummary.error };
        }
        const repo = gitSummary.repositories.find((candidate) => candidate.kind === 'primary');
        if (!repo) return { refreshedAt: Date.now(), error: 'No primary repository found.' };
        const remote = await this.optionalGit(repo.rootPath, ['remote', 'get-url', 'origin']);
        const github = parseGitHubRemote(remote);
        const githubUrl = github ? `https://github.com/${github.owner}/${github.repo}` : undefined;
        let pullRequest: NonNullable<ProjectStatusOverview['repository']>['pullRequest'];
        if (github) {
            try {
                const output = await this.runner(
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
                    this.logger.write('debug', 'project_status.overview_github_unavailable');
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
            refreshedAt: Date.now(),
        };
    }

    private async load(sessionId: string): Promise<ProjectStatusSummary> {
        const startedAt = performance.now();
        const gitSummary = await this.git.summary(sessionId);
        if (!gitSummary.isRepository) {
            return { repositories: [], refreshedAt: Date.now(), error: gitSummary.error };
        }
        const visibleRepositories: GitRepoSummary[] = [];
        for (const repo of gitSummary.repositories)
            if (repo.kind !== 'worktree') visibleRepositories.push(repo);
        const repositories = await Promise.all(
            visibleRepositories.map((repo) => this.loadRepository(repo)),
        );
        this.logger.write('info', 'project_status.summary', {
            durationMs: performance.now() - startedAt,
            fields: { repositories: repositories.length },
        });
        return { repositories, refreshedAt: Date.now() };
    }

    private async optionalGit(cwd: string, arguments_: readonly string[]): Promise<string> {
        try {
            return (await this.runner('git', arguments_, cwd)).trim();
        } catch {
            return '';
        }
    }

    private async loadRepository(repo: GitRepoSummary): Promise<ProjectStatusRepo> {
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
        const [githubState, vercelState] = await Promise.all([
            this.loadGitHub(repo.rootPath, context),
            this.loadVercel(context),
        ]);
        const name = context.repo ?? repo.name;
        const githubUrl =
            context.owner && context.repo
                ? `https://github.com/${context.owner}/${context.repo}`
                : undefined;
        return {
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
            const output = await this.runner(
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
            return { linearIssues: [], errors: [cliError('gh', failure.kind)] };
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
                        await this.runner('linear', arguments_, cwd),
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
                    firstError ??= cliError('linear', failure.kind);
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
        const teamsJson = await this.runner('vc', ['teams', 'ls', '--format', 'json'], homedir());
        const parsed = parseExternalJson(teamsJson, vercelTeamListSchema, 'Vercel team list');
        const teams = (Array.isArray(parsed) ? parsed : (parsed.teams ?? [])).flatMap((team) =>
            team.slug ? [team.slug] : [],
        );
        const links = await Promise.all(
            teams.map(async (team): Promise<VercelLink | undefined> => {
                const output = await this.runner(
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
                this.runner(
                    'vc',
                    vcListArguments(link.team, { ...baseMeta, githubCommitRef: context.branch }),
                    homedir(),
                ),
                this.runner('vc', vcListArguments(link.team, baseMeta, 'production'), homedir()),
                context.head
                    ? this.runner(
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
            return { errors: [cliError('vc', failure.kind)] };
        }
    }

    summary(sessionId: string): Promise<ProjectStatusSummary> {
        return this.requests.run(sessionId, () => this.load(sessionId));
    }

    overview(sessionId: string): Promise<ProjectStatusOverview> {
        return this.overviewRequests.run(sessionId, () => this.loadOverview(sessionId));
    }
}

function vcListArguments(
    team: string,
    meta: Record<string, string>,
    environment?: ProjectStatusDeployment['environment'],
): string[] {
    const arguments_ = ['ls', '--format', 'json', '--scope', team];
    for (const [key, value] of Object.entries(meta)) arguments_.push('--meta', `${key}=${value}`);
    if (environment) arguments_.push('--environment', environment);
    arguments_.push('--yes');
    return arguments_;
}

export async function runProjectStatusCommand(
    command: ProjectStatusCommand,
    arguments_: readonly string[],
    cwd: string,
    dependencies: ProjectStatusCommandDependencies = {},
): Promise<string> {
    try {
        if (command === 'git') {
            // `git` ships with macOS, so it skips login-shell resolution and stays on the sanitized
            // base environment.
            const run = dependencies.run ?? execFileAsync;
            const { stdout } = await run('git', [...arguments_], {
                cwd,
                timeout: CLI_TIMEOUT_MS,
                maxBuffer: CLI_MAX_BUFFER_BYTES,
                env: { ...safeProcessEnvironment(), CI: '1', LC_ALL: 'C' },
            });
            return stdout;
        }
        const { stdout } = await runExternalCommand(
            command,
            arguments_,
            {
                cwd,
                timeout: CLI_TIMEOUT_MS,
                maxBuffer: CLI_MAX_BUFFER_BYTES,
                env: { CI: '1', LC_ALL: 'C' },
            },
            dependencies,
        );
        return stdout;
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
        // `||` (not `??`) is deliberate: an empty `stderr` string carries no useful detail either and
        // should also fall back to `message`.
        throw new ProjectStatusCliError(
            command,
            classifyCliFailure(failure),
            // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- empty stderr string is also not useful detail
            failure.stderr || failure.message,
        );
    }
}
