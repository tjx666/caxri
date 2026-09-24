import { isAbsolute, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { captureCommand } from './command-runner';

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CHANGED_FILES = 100;
const MAX_GITHUB_ITEMS = 1_000;
const GITHUB_SNAPSHOT_ATTEMPTS = 2;

const repoSchema = z.object({
    defaultBranchRef: z.object({ name: z.string().min(1) }),
    nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
});
const issueLabelSchema = z.object({ name: z.string() });
const issueSchema = z.object({
    labels: z.array(issueLabelSchema),
    number: z.number().int().positive(),
    state: z.enum(['OPEN', 'CLOSED']),
    title: z.string(),
    updatedAt: z.string(),
    url: z.url(),
});
const closingRepoOwnerSchema = z.object({ login: z.string() });
const closingRepoSchema = z.union([
    z.object({ nameWithOwner: z.string() }),
    z.object({ name: z.string(), owner: closingRepoOwnerSchema }),
]);
const closingIssueSchema = z.object({
    number: z.number().int().positive(),
    repository: closingRepoSchema,
});
const pullRequestSchema = z.object({
    baseRefName: z.string(),
    closingIssuesReferences: z.array(closingIssueSchema),
    headRefName: z.string(),
    headRefOid: z.string(),
    isDraft: z.boolean(),
    number: z.number().int().positive(),
    state: z.string(),
    title: z.string(),
    updatedAt: z.string(),
    url: z.url(),
});
const projectItemSchema = z.object({
    id: z.string().min(1),
    number: z.number().int().positive(),
    priority: z.string().nullish(),
    repository: z.string(),
    status: z.string().nullish(),
});
const lobeHubIdentitySchema = z.object({ userId: z.string().min(1) });

export interface IntakeSnapshotOptions {
    cwd: string;
    fetch: boolean;
    issueNumbers: number[];
    projectNumber: number;
    projectOwner?: string;
    repository?: string;
}

export interface CommandRunner {
    capture(command: string, arguments_: string[], cwd: string): Promise<string>;
}

interface CliOptions extends IntakeSnapshotOptions {
    help: boolean;
}

interface ProjectItem {
    id: string;
    number: number;
    priority: string | null;
    repository: string;
    status: string | null;
}

const defaultRunner: CommandRunner = {
    async capture(command, arguments_, cwd) {
        return captureCommand(command, arguments_, {
            cwd,
            maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        });
    },
};

function positiveInteger(value: string, option: string): number {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(`${option} must be a positive integer`);
    }
    return parsed;
}

/**
 * Applies one CLI argument to `options` and returns the argv index the loop should resume from. Isolated from the loop
 * body so the switch's `break` statements are not nested inside a loop.
 */
function applyIntakeArgument(
    argument: string,
    arguments_: string[],
    index: number,
    options: CliOptions,
): number {
    switch (argument) {
        case '--help':
        case '-h': {
            options.help = true;
            return index;
        }
        case '--no-fetch': {
            options.fetch = false;
            return index;
        }
        case '--repo': {
            options.repository = arguments_[index + 1];
            if (!options.repository) throw new Error('Missing --repo value');
            return index + 1;
        }
        case '--project-owner': {
            options.projectOwner = arguments_[index + 1];
            if (!options.projectOwner) throw new Error('Missing --project-owner value');
            return index + 1;
        }
        case '--project': {
            options.projectNumber = positiveInteger(arguments_[index + 1] ?? '', '--project');
            return index + 1;
        }
        case '--issue': {
            options.issueNumbers.push(positiveInteger(arguments_[index + 1] ?? '', '--issue'));
            return index + 1;
        }
        default: {
            throw new Error(`Unknown option: ${argument}`);
        }
    }
}

export function parseIntakeSnapshotArguments(
    arguments_: string[],
    cwd = process.cwd(),
): CliOptions {
    const options: CliOptions = {
        cwd,
        fetch: true,
        help: false,
        issueNumbers: [],
        projectNumber: 2,
    };
    let index = 0;
    while (index < arguments_.length) {
        index = applyIntakeArgument(arguments_[index], arguments_, index, options) + 1;
    }
    if (options.repository && !/^[^/]+\/[^/]+$/.test(options.repository)) {
        throw new Error('--repo must use OWNER/REPOSITORY');
    }
    options.issueNumbers = [...new Set(options.issueNumbers)].toSorted((a, b) => a - b);
    return options;
}

function parseJson<T>(source: string, schema: z.ZodType<T>, label: string): T {
    try {
        return schema.parse(JSON.parse(source));
    } catch (error) {
        throw new Error(
            `Invalid ${label} response: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
        );
    }
}

/**
 * `gh api graphql --paginate --jq` prints one compact JSON array per page, one page per line.
 */
function parseProjectItems(source: string): ProjectItem[] {
    return source
        .split('\n')
        .filter((line) => line.trim())
        .flatMap((line) => parseJson(line, z.array(projectItemSchema), 'GitHub Project'))
        .map((item) => ({
            ...item,
            priority: item.priority ?? null,
            status: item.status ?? null,
        }));
}

function parseStatus(source: string) {
    const entries = source
        .split('\n')
        .filter(Boolean)
        .map((line) => ({ path: line.slice(3), status: line.slice(0, 2) }));
    return {
        changedFileCount: entries.length,
        changedFiles: entries.slice(0, MAX_CHANGED_FILES),
        changedFilesTruncated: entries.length > MAX_CHANGED_FILES,
        clean: entries.length === 0,
    };
}

/**
 * Reads only the two single-select values intake needs. `gh project item-list` requests every field value of every item
 * (`fieldValues(first: 100)`), which GitHub bills as 100 nodes per item: ~820 GraphQL points for a 744-item Project, a
 * sixth of the hourly budget the user's shell, Agents, and the Caxri app all share. Named field lookups are not
 * connections, so the same read costs about one point per 100 items.
 *
 * https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api
 */
const PROJECT_ITEMS_QUERY = [
    'query($owner: String!, $number: Int!, $endCursor: String) {',
    '  repositoryOwner(login: $owner) { ... on ProjectV2Owner { projectV2(number: $number) {',
    '    items(first: 100, after: $endCursor) {',
    '      pageInfo { hasNextPage endCursor }',
    '      nodes {',
    '        id',
    '        status: fieldValueByName(name: "Status") { ... on ProjectV2ItemFieldSingleSelectValue { name } }',
    '        priority: fieldValueByName(name: "Priority") { ... on ProjectV2ItemFieldSingleSelectValue { name } }',
    '        content { __typename ... on Issue { number repository { nameWithOwner } } }',
    '      }',
    '    }',
    '  } } }',
    '}',
].join('\n');

const PROJECT_ITEMS_JQ =
    '[.data.repositoryOwner.projectV2.items.nodes[] | select(.content.__typename == "Issue") | {' +
    'id, number: .content.number, repository: .content.repository.nameWithOwner, ' +
    'status: (.status.name // null), priority: (.priority.name // null)}]';

function closingRepoName(repo: z.infer<typeof closingRepoSchema>): string {
    return 'nameWithOwner' in repo ? repo.nameWithOwner : `${repo.owner.login}/${repo.name}`;
}

/**
 * Retries read-only GitHub discovery once because the CLI can surface transient GraphQL transport failures such as an
 * unexpected EOF. Keep this wrapper local to intake so remote mutations are never retried implicitly.
 */
async function captureReadOnlyGitHub(
    runner: CommandRunner,
    arguments_: string[],
    cwd: string,
): Promise<string> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= GITHUB_SNAPSHOT_ATTEMPTS; attempt += 1) {
        try {
            // eslint-disable-next-line no-await-in-loop -- retries must run sequentially so a later attempt only fires after the previous one is known to have failed.
            return await runner.capture('gh', arguments_, cwd);
        } catch (error) {
            lastError = error;
        }
    }
    throw lastError;
}

export async function createIntakeSnapshot(
    options: IntakeSnapshotOptions,
    runner: CommandRunner = defaultRunner,
    capturedAt = new Date().toISOString(),
) {
    const cwd = resolve(options.cwd);
    if (options.fetch) await runner.capture('git', ['fetch', 'origin', '--prune'], cwd);

    const repoArguments = [
        'repo',
        'view',
        ...(options.repository ? [options.repository] : []),
        '--json',
        'nameWithOwner,defaultBranchRef',
    ];
    const repo = parseJson(
        await captureReadOnlyGitHub(runner, repoArguments, cwd),
        repoSchema,
        'GitHub repository',
    );
    const projectOwner = options.projectOwner ?? repo.nameWithOwner.split('/', 1)[0];
    const issueState = options.issueNumbers.length > 0 ? 'all' : 'open';
    const [
        login,
        lobeHubIdentitySource,
        issuesSource,
        pullRequestsSource,
        projectItemsSource,
        branch,
        headSha,
        status,
    ] = await Promise.all([
        captureReadOnlyGitHub(runner, ['api', 'user', '--jq', '.login'], cwd),
        runner.capture('lh', ['whoami', '--json'], cwd),
        captureReadOnlyGitHub(
            runner,
            [
                'issue',
                'list',
                '--repo',
                repo.nameWithOwner,
                '--state',
                issueState,
                '--limit',
                String(MAX_GITHUB_ITEMS),
                '--json',
                'number,title,state,url,labels,updatedAt',
            ],
            cwd,
        ),
        captureReadOnlyGitHub(
            runner,
            [
                'pr',
                'list',
                '--repo',
                repo.nameWithOwner,
                '--state',
                'all',
                '--limit',
                String(MAX_GITHUB_ITEMS),
                '--json',
                'number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,updatedAt,closingIssuesReferences',
            ],
            cwd,
        ),
        captureReadOnlyGitHub(
            runner,
            [
                'api',
                'graphql',
                '--paginate',
                '-f',
                `query=${PROJECT_ITEMS_QUERY}`,
                '-F',
                `owner=${projectOwner}`,
                '-F',
                `number=${options.projectNumber}`,
                '--jq',
                PROJECT_ITEMS_JQ,
            ],
            cwd,
        ),
        runner.capture('git', ['branch', '--show-current'], cwd),
        runner.capture('git', ['rev-parse', 'HEAD'], cwd),
        runner.capture('git', ['status', '--short', '--untracked-files=all'], cwd),
    ]);
    parseJson(lobeHubIdentitySource, lobeHubIdentitySchema, 'LobeHub whoami');
    const allIssues = parseJson(issuesSource, z.array(issueSchema), 'GitHub issues');
    const requested = new Set(options.issueNumbers);
    const issues =
        options.issueNumbers.length > 0
            ? allIssues.filter((issue) => requested.has(issue.number))
            : allIssues;
    const found = new Set(issues.map((issue) => issue.number));
    const missing = options.issueNumbers.filter((number) => !found.has(number));
    if (missing.length > 0) throw new Error(`GitHub issues not found: ${missing.join(', ')}`);

    const pullRequests = parseJson(
        pullRequestsSource,
        z.array(pullRequestSchema),
        'GitHub pull requests',
    );
    const projectItems = parseProjectItems(projectItemsSource);
    const projectByIssue = new Map(
        projectItems.map((item) => [`${item.repository}#${item.number}`, item] as const),
    );
    const selectedIssueNumbers = new Set(issues.map(({ number }) => number));
    const defaultBranchReference = `origin/${repo.defaultBranchRef.name}`;
    const [defaultBranchSha, counts] = await Promise.all([
        runner.capture('git', ['rev-parse', defaultBranchReference], cwd),
        runner.capture(
            'git',
            ['rev-list', '--left-right', '--count', `${defaultBranchReference}...HEAD`],
            cwd,
        ),
    ]);
    const [behindText = '0', aheadText = '0'] = counts.trim().split(/\s+/, 2);

    return {
        authenticatedAs: login.trim(),
        capturedAt,
        issues: issues
            .map((issue) => {
                const project = projectByIssue.get(`${repo.nameWithOwner}#${issue.number}`);
                const relatedPullRequests = pullRequests
                    .filter((pullRequest) =>
                        pullRequest.closingIssuesReferences.some(
                            (candidate) =>
                                candidate.number === issue.number &&
                                closingRepoName(candidate.repository) === repo.nameWithOwner,
                        ),
                    )
                    .map(({ number }) => number);
                return {
                    acceptanceCheckIds: [] as string[],
                    classification: null,
                    dependencies: [] as number[],
                    labels: issue.labels.map(({ name }) => name),
                    number: issue.number,
                    priority: project?.priority ?? null,
                    projectItemId: project?.id ?? null,
                    projectStatus: project?.status ?? null,
                    relatedPullRequests,
                    state: issue.state,
                    title: issue.title,
                    updatedAt: issue.updatedAt,
                    url: issue.url,
                    userVisibleOutcome: null,
                };
            })
            .toSorted((left, right) => left.number - right.number),
        lobeHubAuthenticated: true,
        project: { number: options.projectNumber, owner: projectOwner },
        pullRequests: pullRequests
            .filter(
                (pullRequest) =>
                    pullRequest.state === 'OPEN' ||
                    pullRequest.closingIssuesReferences.some(
                        ({ number, repository: closingRepo }) =>
                            selectedIssueNumbers.has(number) &&
                            closingRepoName(closingRepo) === repo.nameWithOwner,
                    ),
            )
            .map(({ closingIssuesReferences, ...pullRequest }) => ({
                ...pullRequest,
                closingIssueNumbers: closingIssuesReferences
                    .filter(
                        ({ repository: closingRepo }) =>
                            closingRepoName(closingRepo) === repo.nameWithOwner,
                    )
                    .map(({ number }) => number)
                    .toSorted((left, right) => left - right),
            }))
            .toSorted((left, right) => left.number - right.number),
        repository: {
            defaultBranch: repo.defaultBranchRef.name,
            nameWithOwner: repo.nameWithOwner,
        },
        schemaVersion: 2,
        source: {
            ahead: Number(aheadText),
            behind: Number(behindText),
            branch: branch.trim() || null,
            defaultBranchSha: defaultBranchSha.trim(),
            fetchedOrigin: options.fetch,
            headSha: headSha.trim(),
            ...parseStatus(status),
        },
    };
}

function help(): string {
    return `Go intake snapshot

Usage:
  bun run .agents/skills/go/scripts/intake-snapshot.ts [options]

Options:
  --repo OWNER/REPOSITORY  Repository resolved from cwd when omitted
  --project NUMBER         GitHub Project number (default: 2)
  --project-owner OWNER    Project owner (default: repository owner)
  --issue NUMBER           Freeze one issue; repeat to select multiple closed/open issues
  --no-fetch               Use the existing local origin refs
  --help                    Show this help`;
}

async function main(arguments_: string[]): Promise<void> {
    const options = parseIntakeSnapshotArguments(arguments_);
    if (options.help) {
        console.log(help());
        return;
    }
    console.log(JSON.stringify(await createIntakeSnapshot(options), null, 2));
}

const SCRIPT_PATH = resolve(fileURLToPath(import.meta.url));
const invokedPath =
    process.argv[1] && (isAbsolute(process.argv[1]) ? process.argv[1] : resolve(process.argv[1]));
if (invokedPath === SCRIPT_PATH) {
    try {
        await main(process.argv.slice(2));
    } catch (error: unknown) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    }
}
