import { MAX_CONFIGURABLE_FILE_BYTES } from '../../shared/ipc/domain';
import { CaxriError } from '../../shared/ipc/errors';
import type { RuntimeMethodParams } from '../../shared/ipc/methods';
import type {
    GitDiffDocument,
    GitFileStatus,
    GitPullRequestChanges,
    GitRepositorySummary,
} from '../../shared/types';
import { SingleFlight } from '../single-flight';

const PULL_REQUEST_CACHE_MS = 30_000;
const MAX_PULL_REQUEST_FILES = 2_000;

interface PullRequestCacheEntry {
    branch: string;
    expiresAt: number;
    head?: string;
    value: GitPullRequestChanges | null;
}

interface GitHubPullRequestView {
    number: number;
    title: string;
    url: string;
    baseRefName: string;
    headRefName: string;
    baseRefOid: string;
    headRefOid: string;
}

interface GitPullRequestServiceDeps {
    git(
        cwd: string,
        args: string[],
        options?: { allowFailure?: boolean; maxBufferBytes?: number },
    ): Promise<string>;
    ghPullRequestView(cwd: string): Promise<string>;
    resolveRepository(sessionId: string, repositoryId: string): Promise<GitRepositorySummary>;
}

interface NameStatusFile {
    path: string;
    previousPath?: string;
    status: 'added' | 'copied' | 'deleted' | 'modified' | 'renamed' | 'type-changed' | 'unknown';
}

function nameStatus(code: string): NameStatusFile['status'] {
    if (code.startsWith('A')) return 'added';
    if (code.startsWith('D')) return 'deleted';
    if (code.startsWith('R')) return 'renamed';
    if (code.startsWith('C')) return 'copied';
    if (code.startsWith('T')) return 'type-changed';
    if (code.startsWith('M')) return 'modified';
    return 'unknown';
}

function parseNameStatus(output: string): NameStatusFile[] {
    const fields = output.split('\0').filter(Boolean);
    const files: NameStatusFile[] = [];
    for (let index = 0; index < fields.length;) {
        const code = fields[index++];
        if (!code) break;
        if (code.startsWith('R') || code.startsWith('C')) {
            const previousPath = fields[index++];
            const path = fields[index++];
            if (!path || !previousPath)
                throw new CaxriError('GIT', 'Git returned malformed pull request files');
            files.push({ path, previousPath, status: nameStatus(code) });
            continue;
        }
        const path = fields[index++];
        if (!path) throw new CaxriError('GIT', 'Git returned malformed pull request files');
        files.push({ path, status: nameStatus(code) });
    }
    return files;
}

function parseLineStats(output: string): { additions: number; deletions: number } {
    let additions = 0;
    let deletions = 0;
    for (const line of output.split('\n')) {
        const [added, deleted] = line.split('\t', 2);
        if (/^\d+$/.test(added)) additions += Number(added);
        if (/^\d+$/.test(deleted)) deletions += Number(deleted);
    }
    return { additions, deletions };
}

function pullRequestFileStatus(file: NameStatusFile): GitFileStatus {
    const code =
        file.status === 'added'
            ? 'A'
            : file.status === 'deleted'
              ? 'D'
              : file.status === 'renamed'
                ? 'R'
                : 'M';
    return {
        path: file.path,
        originalPath: file.previousPath,
        index: code,
        workingTree: ' ',
        kind:
            file.status === 'added' || file.status === 'copied'
                ? 'added'
                : file.status === 'deleted'
                  ? 'deleted'
                  : file.status === 'renamed'
                    ? 'renamed'
                    : 'modified',
    };
}

function parsePullRequestView(output: string): GitHubPullRequestView {
    let view: GitHubPullRequestView;
    try {
        view = JSON.parse(output) as GitHubPullRequestView;
    } catch {
        throw new CaxriError('GIT', 'GitHub CLI returned malformed pull request metadata');
    }
    if (
        !Number.isInteger(view.number) ||
        view.number <= 0 ||
        !view.title ||
        !URL.canParse(view.url) ||
        !view.baseRefName ||
        !view.headRefName ||
        !/^[0-9a-f]{40}$/.test(view.baseRefOid) ||
        !/^[0-9a-f]{40}$/.test(view.headRefOid)
    ) {
        throw new CaxriError('GIT', 'GitHub CLI returned incomplete pull request metadata');
    }
    return view;
}

export class GitPullRequestService {
    private readonly cache = new Map<string, PullRequestCacheEntry>();
    private readonly requests = new SingleFlight<string, GitPullRequestChanges | null>();

    constructor(private readonly deps: GitPullRequestServiceDeps) {}

    async changes(
        params: RuntimeMethodParams<'git.pullRequestChanges'>,
    ): Promise<GitPullRequestChanges | null> {
        const cacheKey = `${params.sessionId}:${params.repositoryId}`;
        const repository = await this.deps.resolveRepository(params.sessionId, params.repositoryId);
        const cached = this.cache.get(cacheKey);
        if (
            params.refresh === 0 &&
            cached &&
            cached.branch === repository.branch &&
            cached.head === repository.head &&
            cached.expiresAt > Date.now()
        )
            return cached.value;
        const requestKey = `${cacheKey}:${repository.branch}:${repository.head ?? ''}:${params.refresh}`;
        return this.requests.run(requestKey, async () => {
            const output = await this.deps.ghPullRequestView(repository.rootPath);
            if (!output) {
                this.cache.set(cacheKey, {
                    branch: repository.branch,
                    expiresAt: Date.now() + PULL_REQUEST_CACHE_MS,
                    head: repository.head,
                    value: null,
                });
                return null;
            }
            const view = parsePullRequestView(output);
            const range = `${view.baseRefOid}...${view.headRefOid}`;
            const [filesOutput, lineStatsOutput] = await Promise.all([
                this.deps.git(repository.rootPath, [
                    'diff',
                    '--name-status',
                    '-z',
                    '-M',
                    range,
                    '--',
                ]),
                this.deps.git(repository.rootPath, [
                    'diff',
                    '--numstat',
                    '--no-renames',
                    range,
                    '--',
                ]),
            ]);
            const result: GitPullRequestChanges = {
                repositoryId: repository.id,
                number: view.number,
                title: view.title.slice(0, 4_096),
                url: view.url,
                baseRefName: view.baseRefName.slice(0, 1_024),
                headRefName: view.headRefName.slice(0, 1_024),
                baseOid: view.baseRefOid,
                headOid: view.headRefOid,
                ...parseLineStats(lineStatsOutput),
                files: parseNameStatus(filesOutput)
                    .slice(0, MAX_PULL_REQUEST_FILES)
                    .map(pullRequestFileStatus),
            };
            this.cache.set(cacheKey, {
                branch: repository.branch,
                expiresAt: Date.now() + PULL_REQUEST_CACHE_MS,
                head: repository.head,
                value: result,
            });
            return result;
        });
    }

    async diffDocument(
        params: RuntimeMethodParams<'git.pullRequestDiffDocument'>,
    ): Promise<GitDiffDocument> {
        const [repository, pullRequest] = await Promise.all([
            this.deps.resolveRepository(params.sessionId, params.repositoryId),
            this.changes({
                sessionId: params.sessionId,
                repositoryId: params.repositoryId,
                refresh: 0,
            }),
        ]);
        if (!pullRequest) throw new CaxriError('NOT_FOUND', 'No pull request for this branch');
        const file = pullRequest.files.find((candidate) => candidate.path === params.path);
        if (!file) throw new CaxriError('NOT_FOUND', 'Pull request change no longer exists');
        const originalPath = file.originalPath ?? file.path;
        const [original, modified] = await Promise.all([
            file.kind === 'added'
                ? Promise.resolve('')
                : this.deps.git(
                      repository.rootPath,
                      ['show', `${pullRequest.baseOid}:${originalPath}`],
                      {
                          allowFailure: true,
                          maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES,
                      },
                  ),
            file.kind === 'deleted'
                ? Promise.resolve('')
                : this.deps.git(
                      repository.rootPath,
                      ['show', `${pullRequest.headOid}:${file.path}`],
                      {
                          allowFailure: true,
                          maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES,
                      },
                  ),
        ]);
        if (original.includes('\0') || modified.includes('\0') || (!original && !modified)) {
            const patch = await this.deps.git(
                repository.rootPath,
                [
                    'diff',
                    '--no-ext-diff',
                    '--no-color',
                    `${pullRequest.baseOid}...${pullRequest.headOid}`,
                    '--',
                    file.path,
                ],
                { maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES },
            );
            return {
                format: 'patch',
                path: file.path,
                originalPath: file.originalPath,
                original: '',
                modified: patch,
            };
        }
        return {
            format: 'contents',
            path: file.path,
            originalPath: file.originalPath,
            original,
            modified,
        };
    }
}
