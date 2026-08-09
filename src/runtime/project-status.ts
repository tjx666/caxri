import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';

import type { StructuredLogger } from '../shared/node/logger';
import { safeProcessEnvironment } from '../shared/node/process-environment';
import type {
    GitRepositorySummary,
    ProjectStatusCheck,
    ProjectStatusDeployment,
    ProjectStatusError,
    ProjectStatusLinearIssue,
    ProjectStatusOverview,
    ProjectStatusRepository,
    ProjectStatusState,
    ProjectStatusSummary,
} from '../shared/types';
import type { GitService } from './git';
import { resolveRuntimeExecutable, runtimeProcessEnvironment } from './executables';
import { SingleFlight } from './single-flight';

const execFileAsync = promisify(execFile);
const CLI_TIMEOUT_MS = 8_000;
const CLI_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
/** Caps the process-lifetime `vercelLinks` cache so long-running sessions can't grow it unbounded. */
const VERCEL_LINK_CACHE_LIMIT = 256;

type ProjectStatusCommand = 'gh' | 'git' | 'linear' | 'vc';
type CliFailureKind =
    'not-found' | 'not-logged-in' | 'not-linked' | 'rate-limited' | 'timeout' | 'other';

export type ProjectStatusRunner = (
    command: ProjectStatusCommand,
    args: readonly string[],
    cwd: string,
) => Promise<string>;

type RunProjectStatusFile = (
    executable: string,
    args: string[],
    options: {
        cwd: string;
        timeout: number;
        maxBuffer: number;
        env: NodeJS.ProcessEnv;
    },
) => Promise<{ stdout: string }>;

export interface ProjectStatusCommandDependencies {
    environment?: () => Promise<NodeJS.ProcessEnv>;
    resolveExecutable?: (name: string) => Promise<string | undefined>;
    run?: RunProjectStatusFile;
}

const runProjectStatusFile: RunProjectStatusFile = async (executable, args, options) => {
    const { stdout } = await execFileAsync(executable, args, options);
    return { stdout };
};

class ProjectStatusCliError extends Error {
    constructor(
        readonly command: ProjectStatusCommand,
        readonly kind: CliFailureKind,
        message: string,
    ) {
        super(message);
    }
}

interface GitHubCheck {
    __typename?: string;
    completedAt?: string | null;
    conclusion?: string | null;
    context?: string;
    detailsUrl?: string;
    name?: string;
    startedAt?: string | null;
    state?: string | null;
    status?: string | null;
    targetUrl?: string;
    workflowName?: string;
}

interface GitHubPullRequest {
    body?: string;
    number?: number;
    statusCheckRollup?: GitHubCheck[];
    title?: string;
    url?: string;
}

interface VercelDeployment {
    created?: number;
    name?: string;
    readyState?: string;
    state?: string;
    target?: 'production' | 'preview' | null;
    url?: string;
}

export interface VercelLink {
    project: string;
    team: string;
}

interface LinearReference {
    identifier: string;
    workspace?: string;
}

interface RepositoryContext {
    branch: string;
    defaultBranch?: string;
    head?: string;
    owner?: string;
    repo?: string;
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

function parseJson<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

function classifyCliFailure(
    error: NodeJS.ErrnoException & { killed?: boolean; stderr?: string },
): CliFailureKind {
    const stderr = error.stderr ?? error.message ?? '';
    if (error.code === 'ENOENT') return 'not-found';
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
    const markerPattern = REFERENCE_MARKERS.map((marker) => marker.replaceAll(' ', '\\s+')).join(
        '|',
    );
    const referenceLine = new RegExp(`(?:^|\\b)(?:${markerPattern})\\b([^\\n]*)`, 'giu');
    for (const marker of body.matchAll(referenceLine)) {
        for (const identifier of marker[1].matchAll(/\b([a-z][a-z0-9]*-[1-9]\d*)\b/giu)) {
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
    pullRequest?: ProjectStatusRepository['pullRequest'];
} {
    const raw = parseJson<GitHubPullRequest>(value, {});
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
    if (state === 'BUILDING' || state === 'QUEUED' || state === 'INITIALIZING') return 'pending';
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
 * Inserts into the LRU-bounded `vercelLinks` cache, evicting the oldest entry once over capacity.
 * Mirrors the eviction pattern used by `files/watcher.ts`'s `rememberPolledDirectory`/
 * `rememberChangeFingerprint`: re-inserting a key refreshes its recency, and eviction removes the
 * least-recently-used entry (the `Map` iteration order's first key).
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
    const parsed = parseJson<VercelDeployment[] | { deployments?: VercelDeployment[] }>(value, []);
    const deployments = Array.isArray(parsed) ? parsed : (parsed.deployments ?? []);
    return deployments.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0));
}

export class ProjectStatusService {
    private readonly requests = new SingleFlight<string, ProjectStatusSummary>();
    private readonly overviewRequests = new SingleFlight<string, ProjectStatusOverview>();
    /** LRU-bounded (see `VERCEL_LINK_CACHE_LIMIT`) so this process-lifetime cache can't grow unbounded. */
    private readonly vercelLinks = new Map<string, VercelLink>();

    constructor(
        private readonly git: Pick<GitService, 'summary'>,
        private readonly logger: StructuredLogger,
        private readonly runner: ProjectStatusRunner = runProjectStatusCommand,
    ) {}

    summary(sessionId: string): Promise<ProjectStatusSummary> {
        return this.requests.run(sessionId, () => this.load(sessionId));
    }

    overview(sessionId: string): Promise<ProjectStatusOverview> {
        return this.overviewRequests.run(sessionId, () => this.loadOverview(sessionId));
    }

    private async loadOverview(sessionId: string): Promise<ProjectStatusOverview> {
        const gitSummary = await this.git.summary(sessionId);
        if (!gitSummary.isRepository) {
            return { refreshedAt: Date.now(), error: gitSummary.error };
        }
        const repository = gitSummary.repositories.find(
            (candidate) => candidate.kind === 'primary',
        );
        if (!repository) return { refreshedAt: Date.now(), error: 'No primary repository found.' };
        const remote = await this.optionalGit(repository.rootPath, ['remote', 'get-url', 'origin']);
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
                        repository.branch,
                        '--repo',
                        `${github.owner}/${github.repo}`,
                        '--json',
                        'number,title,url',
                    ],
                    repository.rootPath,
                );
                const parsed = parseJson<GitHubPullRequest>(output, {});
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
                id: repository.id,
                branch: repository.branch,
                branchUrl: githubUrl
                    ? `${githubUrl}/tree/${encodeURIComponent(repository.branch)}`
                    : undefined,
                changedFileCount: repository.files.length,
                additions: repository.additions,
                deletions: repository.deletions,
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
        const visibleRepositories: GitRepositorySummary[] = [];
        for (const repository of gitSummary.repositories)
            if (repository.kind !== 'worktree') visibleRepositories.push(repository);
        const repositories = await Promise.all(
            visibleRepositories.map((repository) => this.loadRepository(repository)),
        );
        this.logger.write('info', 'project_status.summary', {
            durationMs: performance.now() - startedAt,
            fields: { repositories: repositories.length },
        });
        return { repositories, refreshedAt: Date.now() };
    }

    private async optionalGit(cwd: string, args: readonly string[]): Promise<string> {
        try {
            return (await this.runner('git', args, cwd)).trim();
        } catch {
            return '';
        }
    }

    private async loadRepository(
        repository: GitRepositorySummary,
    ): Promise<ProjectStatusRepository> {
        const [remote, defaultBranch, head] = await Promise.all([
            this.optionalGit(repository.rootPath, ['remote', 'get-url', 'origin']),
            this.optionalGit(repository.rootPath, [
                'symbolic-ref',
                '--short',
                'refs/remotes/origin/HEAD',
            ]),
            this.optionalGit(repository.rootPath, ['rev-parse', 'HEAD']),
        ]);
        const github = parseGitHubRemote(remote);
        const context: RepositoryContext = {
            branch: repository.branch,
            defaultBranch: defaultBranch.replace(/^origin\//, '') || undefined,
            head: head || undefined,
            owner: github?.owner,
            repo: github?.repo,
        };
        const [githubState, vercelState] = await Promise.all([
            this.loadGitHub(repository.rootPath, context),
            this.loadVercel(context),
        ]);
        const name = context.repo ?? repository.name;
        const githubUrl =
            context.owner && context.repo
                ? `https://github.com/${context.owner}/${context.repo}`
                : undefined;
        return {
            id: repository.id,
            kind: repository.kind,
            name,
            rootPath: repository.rootPath,
            branch: repository.branch,
            defaultBranch: context.defaultBranch,
            githubUrl,
            branchUrl: githubUrl
                ? `${githubUrl}/tree/${encodeURIComponent(repository.branch)}`
                : undefined,
            pullRequest: githubState.pullRequest,
            linearIssues: githubState.linearIssues,
            deployments: vercelState.deployments,
            errors: [...githubState.errors, ...vercelState.errors],
        };
    }

    private async loadGitHub(
        cwd: string,
        context: RepositoryContext,
    ): Promise<
        Pick<ProjectStatusRepository, 'pullRequest' | 'linearIssues'> & {
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
                    const args = [
                        'api',
                        LINEAR_ISSUE_QUERY,
                        '--variable',
                        `id=${reference.identifier}`,
                    ];
                    if (reference.workspace) args.push('--workspace', reference.workspace);
                    const raw = parseJson<{
                        data?: {
                            issue?: {
                                identifier?: string;
                                title?: string;
                                url?: string;
                                state?: {
                                    name?: string;
                                    type?: ProjectStatusLinearIssue['stateType'];
                                };
                            };
                        };
                    }>(await this.runner('linear', args, cwd), {});
                    const issue = raw.data?.issue;
                    return {
                        identifier: issue?.identifier ?? reference.identifier,
                        title: issue?.title,
                        url: issue?.url,
                        state: issue?.state?.name,
                        stateType: issue?.state?.type,
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
        const parsed = parseJson<Array<{ slug?: string }> | { teams?: Array<{ slug?: string }> }>(
            teamsJson,
            [],
        );
        const teams = (Array.isArray(parsed) ? parsed : (parsed.teams ?? [])).flatMap((team) =>
            team.slug ? [team.slug] : [],
        );
        const links = await Promise.all(
            teams.map(async (team): Promise<VercelLink | undefined> => {
                const output = await this.runner(
                    'vc',
                    vcListArgs(team, { githubOrg: owner, githubRepo: repo }),
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
        context: RepositoryContext,
    ): Promise<Pick<ProjectStatusRepository, 'deployments'> & { errors: ProjectStatusError[] }> {
        if (!context.owner || !context.repo) return { errors: [] };
        try {
            const link = await this.findVercelLink(context.owner, context.repo);
            if (!link) return { errors: [] };
            const baseMeta = { githubOrg: context.owner, githubRepo: context.repo };
            const results = await Promise.all([
                this.runner(
                    'vc',
                    vcListArgs(link.team, { ...baseMeta, githubCommitRef: context.branch }),
                    homedir(),
                ),
                this.runner('vc', vcListArgs(link.team, baseMeta, 'production'), homedir()),
                context.head
                    ? this.runner(
                          'vc',
                          vcListArgs(link.team, { githubCommitSha: context.head }, 'preview'),
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
}

function vcListArgs(
    team: string,
    meta: Record<string, string>,
    environment?: ProjectStatusDeployment['environment'],
): string[] {
    const args = ['ls', '--format', 'json', '--scope', team];
    for (const [key, value] of Object.entries(meta)) args.push('--meta', `${key}=${value}`);
    if (environment) args.push('--environment', environment);
    args.push('--yes');
    return args;
}

export async function runProjectStatusCommand(
    command: ProjectStatusCommand,
    args: readonly string[],
    cwd: string,
    dependencies: ProjectStatusCommandDependencies = {},
): Promise<string> {
    try {
        const resolveExecutable = dependencies.resolveExecutable ?? resolveRuntimeExecutable;
        const readEnvironment = dependencies.environment ?? runtimeProcessEnvironment;
        const run = dependencies.run ?? runProjectStatusFile;
        const executable = command === 'git' ? command : await resolveExecutable(command);
        if (!executable) {
            const missing = new Error(`${command} was not found`) as NodeJS.ErrnoException;
            missing.code = 'ENOENT';
            throw missing;
        }
        const environment = command === 'git' ? safeProcessEnvironment() : await readEnvironment();
        const { stdout } = await run(executable, [...args], {
            cwd,
            timeout: CLI_TIMEOUT_MS,
            maxBuffer: CLI_MAX_BUFFER_BYTES,
            env: { ...environment, CI: '1', LC_ALL: 'C' },
        });
        return stdout;
    } catch (error) {
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
        throw new ProjectStatusCliError(
            command,
            classifyCliFailure(failure),
            failure.stderr || failure.message,
        );
    }
}
