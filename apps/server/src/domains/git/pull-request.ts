import type {
    GitDiffDocument,
    GitFileStatus,
    GitPullRequestChanges,
    GitRepositorySummary as GitRepoSummary,
    ServerOperationParameters,
} from '@caxri/protocol';
import { CaxriError, MAX_CONFIGURABLE_FILE_BYTES } from '@caxri/protocol';
import { rememberBounded } from '@caxri/utils';
import { GitPullRequestErrorMessage } from 'caxri';
import { z } from 'zod';

import { SingleFlight } from '../single-flight';
import { parseGitNumstat, sumGitLineStats, withGitLineStat } from './numstat';
import { sharedGitRequest } from './request-signal';

const PULL_REQUEST_CACHE_MS = 30_000;
const MAX_PULL_REQUEST_FILES = 2_000;
const MAX_PULL_REQUEST_CACHE_ENTRIES = 128;

interface PullRequestCacheEntry {
    branch: string;
    expiresAt: number;
    head?: string;
    repositoryId: string;
    sessionId: string;
    value: GitPullRequestChanges | null;
}

const githubPullRequestViewSchema = z.object({
    number: z.number().int().positive(),
    title: z.string().min(1),
    url: z.string().refine((value) => URL.canParse(value), 'Invalid pull request URL'),
    baseRefName: z.string().min(1),
    headRefName: z.string().min(1),
    baseRefOid: z.string().regex(/^[0-9a-f]{40}$/),
    headRefOid: z.string().regex(/^[0-9a-f]{40}$/),
});

type GitHubPullRequestView = z.infer<typeof githubPullRequestViewSchema>;

interface GitPullRequestServiceDependencies {
    git(
        cwd: string,
        arguments_: string[],
        options?: { allowFailure?: boolean; maxBufferBytes?: number },
    ): Promise<string>;
    /**
     * Reads the repository's pull request through the Server-wide GitHub projection, so opening a PR diff reuses the
     * record the sidebar badge and the Status panel already hold instead of spending a query of its own. Resolves to
     * `undefined` when the branch has no pull request. `isForced` marks an explicit user refresh, which must reach
     * GitHub rather than reuse the shared record: a force-push changes the head OID this diff is computed from.
     */
    pullRequestView(repo: GitRepoSummary, isForced: boolean): Promise<string | undefined>;
    resolveRepository(sessionId: string, repoId: string): Promise<GitRepoSummary>;
}

interface GitPullRequestServiceOptions {
    maximumCacheEntries?: number;
    now?: () => number;
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

function parseCommitCount(output: string): number {
    const value = output.trim();
    if (!/^\d+$/.test(value)) throw new CaxriError('GIT', 'Git returned a malformed commit count');
    return Number(value);
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

export function parsePullRequestView(output: string): GitHubPullRequestView {
    let parsed: unknown;
    try {
        parsed = JSON.parse(output);
    } catch {
        throw new CaxriError('GIT', 'GitHub CLI returned malformed pull request metadata');
    }
    const view = githubPullRequestViewSchema.safeParse(parsed);
    if (!view.success)
        throw new CaxriError('GIT', 'GitHub CLI returned incomplete pull request metadata');
    return view.data;
}

export class GitPullRequestService {
    private readonly cache = new Map<string, PullRequestCacheEntry>();
    private readonly requests = new SingleFlight<string, GitPullRequestChanges | null>();
    private readonly maximumCacheEntries: number;
    private readonly now: () => number;
    /**
     * Invalidates cache writes that began before a Session deletion or Server shutdown.
     */
    private cacheGeneration = 0;

    constructor(
        private readonly dependencies: GitPullRequestServiceDependencies,
        options: GitPullRequestServiceOptions = {},
    ) {
        this.maximumCacheEntries = options.maximumCacheEntries ?? MAX_PULL_REQUEST_CACHE_ENTRIES;
        this.now = options.now ?? Date.now;
    }

    private pruneCache(now: number): void {
        for (const [cacheKey, entry] of this.cache) {
            if (entry.expiresAt <= now) this.cache.delete(cacheKey);
        }
    }

    private storeCache(cacheKey: string, entry: PullRequestCacheEntry): void {
        this.pruneCache(this.now());
        rememberBounded(this.cache, cacheKey, entry, this.maximumCacheEntries);
    }

    /**
     * GitHub can report commits a clone (including an independently cloned submodule) has never fetched. Fetch only
     * missing, validated OIDs from the same origin used for PR discovery. Empty refmap and disabled FETCH_HEAD, tags,
     * submodule recursion, and maintenance preserve user refs and avoid unrelated repository work.
     */
    private async ensureCommits(rootPath: string, view: GitHubPullRequestView): Promise<void> {
        const oids = [...new Set([view.baseRefOid, view.headRefOid])];
        const types = await Promise.all(
            oids.map((oid) =>
                this.dependencies.git(rootPath, ['cat-file', '-t', oid], { allowFailure: true }),
            ),
        );
        const missing = oids.filter((_, index) => types[index].trim() !== 'commit');
        if (missing.length === 0) return;
        try {
            await this.dependencies.git(rootPath, [
                'fetch',
                '--no-tags',
                '--no-write-fetch-head',
                '--no-recurse-submodules',
                '--no-auto-maintenance',
                '--refmap=',
                'origin',
                ...missing,
            ]);
        } catch {
            throw new CaxriError('GIT', GitPullRequestErrorMessage.missingCommits);
        }
    }

    /**
     * Removes file-list cache entries for Sessions whose backing records were deleted.
     */
    evictSessions(sessionIds: readonly string[]): void {
        if (sessionIds.length === 0) return;
        const removed = new Set(sessionIds);
        for (const [cacheKey, entry] of this.cache) {
            if (removed.has(entry.sessionId)) this.cache.delete(cacheKey);
        }
        this.cacheGeneration += 1;
    }

    /**
     * Releases every retained Pull Request file list when the Server shuts down.
     */
    clear(): void {
        this.cache.clear();
        this.cacheGeneration += 1;
    }

    async changes(
        parameters: ServerOperationParameters<'git.pullRequestChanges'>,
    ): Promise<GitPullRequestChanges | null> {
        const cacheGeneration = this.cacheGeneration;
        const cacheKey = JSON.stringify([parameters.sessionId, parameters.repositoryId]);
        const repo = await this.dependencies.resolveRepository(
            parameters.sessionId,
            parameters.repositoryId,
        );
        const now = this.now();
        this.pruneCache(now);
        const cached = this.cache.get(cacheKey);
        if (
            cached &&
            parameters.refresh === 0 &&
            cached.branch === repo.branch &&
            cached.head === repo.head &&
            cached.expiresAt > now
        ) {
            this.cache.delete(cacheKey);
            this.cache.set(cacheKey, cached);
            return cached.value;
        }
        const requestKey = JSON.stringify([
            parameters.sessionId,
            parameters.repositoryId,
            repo.branch,
            repo.head ?? null,
            parameters.refresh,
        ]);
        return sharedGitRequest(() =>
            this.requests.run(requestKey, async () => {
                const output = await this.dependencies.pullRequestView(
                    repo,
                    parameters.refresh !== 0,
                );
                if (!output) {
                    if (cacheGeneration === this.cacheGeneration)
                        this.storeCache(cacheKey, {
                            branch: repo.branch,
                            expiresAt: this.now() + PULL_REQUEST_CACHE_MS,
                            head: repo.head,
                            repositoryId: parameters.repositoryId,
                            sessionId: parameters.sessionId,
                            value: null,
                        });
                    return null;
                }
                const view = parsePullRequestView(output);
                await this.ensureCommits(repo.rootPath, view);
                const range = `${view.baseRefOid}...${view.headRefOid}`;
                const [filesOutput, lineStatsOutput, unpushedCommitCount] = await Promise.all([
                    this.dependencies.git(repo.rootPath, [
                        'diff',
                        '--name-status',
                        '-z',
                        '-M',
                        range,
                        '--',
                    ]),
                    this.dependencies.git(repo.rootPath, [
                        'diff',
                        '--numstat',
                        '-z',
                        '--no-renames',
                        range,
                        '--',
                    ]),
                    repo.head && repo.head !== view.headRefOid
                        ? (async () =>
                              parseCommitCount(
                                  await this.dependencies.git(repo.rootPath, [
                                      'rev-list',
                                      '--count',
                                      `${view.headRefOid}..${repo.head}`,
                                      '--',
                                  ]),
                              ))()
                        : Promise.resolve(0),
                ]);
                const lineStats = parseGitNumstat(lineStatsOutput);
                const result: GitPullRequestChanges = {
                    repositoryId: repo.id,
                    number: view.number,
                    title: view.title.slice(0, 4_096),
                    url: view.url,
                    baseRefName: view.baseRefName.slice(0, 1_024),
                    headRefName: view.headRefName.slice(0, 1_024),
                    baseOid: view.baseRefOid,
                    headOid: view.headRefOid,
                    unpushedCommitCount,
                    ...sumGitLineStats(lineStats.values()),
                    files: parseNameStatus(filesOutput)
                        .slice(0, MAX_PULL_REQUEST_FILES)
                        .map((file) => withGitLineStat(pullRequestFileStatus(file), lineStats)),
                };
                if (cacheGeneration === this.cacheGeneration)
                    this.storeCache(cacheKey, {
                        branch: repo.branch,
                        expiresAt: this.now() + PULL_REQUEST_CACHE_MS,
                        head: repo.head,
                        repositoryId: parameters.repositoryId,
                        sessionId: parameters.sessionId,
                        value: result,
                    });
                return result;
            }),
        );
    }

    async diffDocument(
        parameters: ServerOperationParameters<'git.pullRequestDiffDocument'>,
    ): Promise<GitDiffDocument> {
        const [repo, pullRequest] = await Promise.all([
            this.dependencies.resolveRepository(parameters.sessionId, parameters.repositoryId),
            this.changes({
                sessionId: parameters.sessionId,
                repositoryId: parameters.repositoryId,
                refresh: 0,
            }),
        ]);
        if (!pullRequest) throw new CaxriError('NOT_FOUND', 'No pull request for this branch');
        const file = pullRequest.files.find((candidate) => candidate.path === parameters.path);
        if (!file) throw new CaxriError('NOT_FOUND', 'Pull request change no longer exists');
        const originalPath = file.originalPath ?? file.path;
        const [original, modified] = await Promise.all([
            file.kind === 'added'
                ? Promise.resolve('')
                : this.dependencies.git(
                      repo.rootPath,
                      ['show', `${pullRequest.baseOid}:${originalPath}`],
                      {
                          allowFailure: true,
                          maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES,
                      },
                  ),
            file.kind === 'deleted'
                ? Promise.resolve('')
                : this.dependencies.git(
                      repo.rootPath,
                      ['show', `${pullRequest.headOid}:${file.path}`],
                      {
                          allowFailure: true,
                          maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES,
                      },
                  ),
        ]);
        if (original.includes('\0') || modified.includes('\0') || (!original && !modified)) {
            const patch = await this.dependencies.git(
                repo.rootPath,
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
