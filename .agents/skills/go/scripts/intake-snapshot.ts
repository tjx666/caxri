import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { captureCommand } from './command-runner';

const MAX_COMMAND_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_CHANGED_FILES = 100;
const MAX_GITHUB_ITEMS = 1_000;

const repositorySchema = z.object({
    defaultBranchRef: z.object({ name: z.string().min(1) }),
    nameWithOwner: z.string().regex(/^[^/]+\/[^/]+$/),
});
const issueSchema = z.object({
    labels: z.array(z.object({ name: z.string() })),
    number: z.number().int().positive(),
    state: z.enum(['OPEN', 'CLOSED']),
    title: z.string(),
    updatedAt: z.string(),
    url: z.url(),
});
const closingRepositorySchema = z.union([
    z.object({ nameWithOwner: z.string() }),
    z.object({ name: z.string(), owner: z.object({ login: z.string() }) }),
]);
const closingIssueSchema = z.object({
    number: z.number().int().positive(),
    repository: closingRepositorySchema,
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

export interface IntakeSnapshotOptions {
    cwd: string;
    fetch: boolean;
    issueNumbers: number[];
    projectNumber: number;
    projectOwner?: string;
    repository?: string;
}

export interface CommandRunner {
    capture(command: string, args: string[], cwd: string): Promise<string>;
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
    async capture(command, args, cwd) {
        return captureCommand(command, args, {
            cwd,
            maxOutputBytes: MAX_COMMAND_OUTPUT_BYTES,
        });
    },
};

function positiveInteger(value: string, option: string): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`${option} must be a positive integer`);
    }
    return parsed;
}

export function parseIntakeSnapshotArguments(args: string[], cwd = process.cwd()): CliOptions {
    const options: CliOptions = {
        cwd,
        fetch: true,
        help: false,
        issueNumbers: [],
        projectNumber: 2,
    };
    for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === '--help' || argument === '-h') options.help = true;
        else if (argument === '--no-fetch') options.fetch = false;
        else if (argument === '--repo') {
            options.repository = args[++index];
            if (!options.repository) throw new Error('Missing --repo value');
        } else if (argument === '--project-owner') {
            options.projectOwner = args[++index];
            if (!options.projectOwner) throw new Error('Missing --project-owner value');
        } else if (argument === '--project') {
            options.projectNumber = positiveInteger(args[++index] ?? '', '--project');
        } else if (argument === '--issue') {
            options.issueNumbers.push(positiveInteger(args[++index] ?? '', '--issue'));
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }
    }
    if (options.repository && !/^[^/]+\/[^/]+$/.test(options.repository)) {
        throw new Error('--repo must use OWNER/REPOSITORY');
    }
    options.issueNumbers = [...new Set(options.issueNumbers)].sort((a, b) => a - b);
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

function parseProjectItems(source: string): ProjectItem[] {
    return parseJson(source, z.array(projectItemSchema), 'GitHub Project').map((item) => ({
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

function projectItemQuery(): string {
    return (
        '[.items[] | select(.content.type == "Issue") | {' +
        'id, number: .content.number, repository: .content.repository, ' +
        'status: (.status // null), priority: (.priority // null)}]'
    );
}

function closingRepositoryName(repository: z.infer<typeof closingRepositorySchema>): string {
    return 'nameWithOwner' in repository
        ? repository.nameWithOwner
        : `${repository.owner.login}/${repository.name}`;
}

export async function createIntakeSnapshot(
    options: IntakeSnapshotOptions,
    runner: CommandRunner = defaultRunner,
    capturedAt = new Date().toISOString(),
) {
    const cwd = resolve(options.cwd);
    if (options.fetch) await runner.capture('git', ['fetch', 'origin', '--prune'], cwd);

    const repositoryArguments = [
        'repo',
        'view',
        ...(options.repository ? [options.repository] : []),
        '--json',
        'nameWithOwner,defaultBranchRef',
    ];
    const repository = parseJson(
        await runner.capture('gh', repositoryArguments, cwd),
        repositorySchema,
        'GitHub repository',
    );
    const projectOwner = options.projectOwner ?? repository.nameWithOwner.split('/')[0];
    const issueState = options.issueNumbers.length > 0 ? 'all' : 'open';
    const [login, issuesSource, pullRequestsSource, projectItemsSource, branch, headSha, status] =
        await Promise.all([
            runner.capture('gh', ['api', 'user', '--jq', '.login'], cwd),
            runner.capture(
                'gh',
                [
                    'issue',
                    'list',
                    '--repo',
                    repository.nameWithOwner,
                    '--state',
                    issueState,
                    '--limit',
                    String(MAX_GITHUB_ITEMS),
                    '--json',
                    'number,title,state,url,labels,updatedAt',
                ],
                cwd,
            ),
            runner.capture(
                'gh',
                [
                    'pr',
                    'list',
                    '--repo',
                    repository.nameWithOwner,
                    '--state',
                    'all',
                    '--limit',
                    String(MAX_GITHUB_ITEMS),
                    '--json',
                    'number,title,state,url,isDraft,headRefName,headRefOid,baseRefName,updatedAt,closingIssuesReferences',
                ],
                cwd,
            ),
            runner.capture(
                'gh',
                [
                    'project',
                    'item-list',
                    String(options.projectNumber),
                    '--owner',
                    projectOwner,
                    '--format',
                    'json',
                    '--limit',
                    String(MAX_GITHUB_ITEMS),
                    '--jq',
                    projectItemQuery(),
                ],
                cwd,
            ),
            runner.capture('git', ['branch', '--show-current'], cwd),
            runner.capture('git', ['rev-parse', 'HEAD'], cwd),
            runner.capture('git', ['status', '--short', '--untracked-files=all'], cwd),
        ]);
    const allIssues = parseJson(issuesSource, z.array(issueSchema), 'GitHub issues');
    const requested = new Set(options.issueNumbers);
    const issues = options.issueNumbers.length
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
    const defaultBranchRef = `origin/${repository.defaultBranchRef.name}`;
    const [defaultBranchSha, counts] = await Promise.all([
        runner.capture('git', ['rev-parse', defaultBranchRef], cwd),
        runner.capture(
            'git',
            ['rev-list', '--left-right', '--count', `${defaultBranchRef}...HEAD`],
            cwd,
        ),
    ]);
    const [behindText = '0', aheadText = '0'] = counts.trim().split(/\s+/);

    return {
        authenticatedAs: login.trim(),
        capturedAt,
        issues: issues
            .map((issue) => {
                const project = projectByIssue.get(`${repository.nameWithOwner}#${issue.number}`);
                const relatedPullRequests = pullRequests
                    .filter((pullRequest) =>
                        pullRequest.closingIssuesReferences.some(
                            (candidate) =>
                                candidate.number === issue.number &&
                                closingRepositoryName(candidate.repository) ===
                                    repository.nameWithOwner,
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
            .sort((left, right) => left.number - right.number),
        project: { number: options.projectNumber, owner: projectOwner },
        pullRequests: pullRequests
            .filter(
                (pullRequest) =>
                    pullRequest.state === 'OPEN' ||
                    pullRequest.closingIssuesReferences.some(
                        ({ number, repository: closingRepository }) =>
                            selectedIssueNumbers.has(number) &&
                            closingRepositoryName(closingRepository) === repository.nameWithOwner,
                    ),
            )
            .map(({ closingIssuesReferences, ...pullRequest }) => ({
                ...pullRequest,
                closingIssueNumbers: closingIssuesReferences
                    .filter(
                        ({ repository: closingRepository }) =>
                            closingRepositoryName(closingRepository) === repository.nameWithOwner,
                    )
                    .map(({ number }) => number)
                    .sort((left, right) => left - right),
            }))
            .sort((left, right) => left.number - right.number),
        repository: {
            defaultBranch: repository.defaultBranchRef.name,
            nameWithOwner: repository.nameWithOwner,
        },
        schemaVersion: 1,
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

async function main(args: string[]): Promise<void> {
    const options = parseIntakeSnapshotArguments(args);
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
    void main(process.argv.slice(2)).catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
