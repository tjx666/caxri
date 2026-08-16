import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../../shared/ipc';
import { CaxriError, errorMessage, isCaxriError } from '../../shared/ipc/errors';
import type { RuntimeEvent } from '../../shared/ipc/events';
import type { RuntimeMethodParams as RuntimeMethodParameters } from '../../shared/ipc/methods';
import { AsyncSemaphore } from '../../shared/node/concurrency';
import type { StructuredLogger } from '../../shared/node/logger';
import { safeProcessEnvironment } from '../../shared/node/process-environment';
import type {
    GitCommit,
    GitCommitDetails,
    GitCommitFile,
    GitCommitPage,
    GitDiffDocument,
    GitFileStatus,
    GitOverview,
    GitRepositorySummary as GitRepoSummary,
    GitSummary,
} from '../../shared/types';
import { assertInsideRoot } from '../path-security';
import type { ProjectRootResolver } from '../project-roots';
import { SingleFlight } from '../single-flight';
import { GitBlameService } from './blame';
import { GitChangeTracker } from './change-tracker';
import { COMMIT_FORMAT, parseCommitLog } from './commit-log';
import { toGitError } from './errors';
import type { GitMetadataWatcherOptions } from './metadata-watcher';
import { GitMetadataWatcher } from './metadata-watcher';
import { GitPullRequestService } from './pull-request';
import { computeRepoId, GitRepoService } from './repo';
import { RepoTopologyRegistry } from './topology';

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT_GIT_COMMANDS = 8;
const MAX_GIT_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_COMMIT_FILES = 500;
const MAX_LOCAL_BRANCHES = 1_000;

interface GitCommandOptions {
    allowFailure?: boolean;
    input?: string;
    maxBufferBytes?: number;
}

interface DiffTarget {
    candidate: string;
    file: GitFileStatus;
    relativePath: string;
    repository: GitRepoSummary;
}

export interface GitWorktreeTopology {
    repositoryKey: string;
    worktrees: Array<{ branch: string; rootPath: string }>;
}
export { describeGitFailure } from './errors';

/**
 * Subcommand-bearing Git operations whose second argv token is required to attribute a command in structured logs
 * (`worktree list` vs `worktree add`); every other operation logs argv[0] alone so no user-controlled path or ref ever
 * reaches the log stream.
 */
const SUBCOMMAND_OPERATIONS = new Set(['worktree', 'remote', 'stash', 'submodule']);

function classifyGitOperation(arguments_: readonly string[]): string {
    const operation = arguments_[0] ?? 'unknown';
    if (!SUBCOMMAND_OPERATIONS.has(operation)) return operation;
    const subcommand = arguments_.find((token, index) => index > 0 && !token.startsWith('-'));
    return subcommand ? `${operation}.${subcommand}` : operation;
}

/**
 * Stable, non-reversible identity for correlating commands of one repository in diagnostics without recording the
 * filesystem path itself.
 */
function hashRepoPath(path: string): string {
    return createHash('sha256').update(path).digest('hex').slice(0, 12);
}

function commitFileStatus(code: string): GitCommitFile['status'] {
    if (code.startsWith('A')) return 'added';
    if (code.startsWith('D')) return 'deleted';
    if (code.startsWith('R')) return 'renamed';
    if (code.startsWith('C')) return 'copied';
    if (code.startsWith('T')) return 'type-changed';
    if (code.startsWith('M')) return 'modified';
    return 'unknown';
}

function parseCommitFiles(output: string): GitCommitFile[] {
    const fields = output.split('\0').filter(Boolean);
    const files: GitCommitFile[] = [];
    for (let index = 0; index < fields.length;) {
        const code = fields[index++];
        if (!code) break;
        if (code.startsWith('R') || code.startsWith('C')) {
            const previousPath = fields[index++];
            const path = fields[index++];
            if (!path || !previousPath)
                throw new CaxriError('GIT', 'Git returned malformed commit files');
            files.push({ path, previousPath, status: commitFileStatus(code) });
            continue;
        }
        const path = fields[index++];
        if (!path) throw new CaxriError('GIT', 'Git returned malformed commit files');
        files.push({ path, status: commitFileStatus(code) });
    }
    return files;
}

/**
 * Sums `git diff-tree --numstat -z` output. A record is `added\tdeleted\tpath` for ordinary files; a rename/copy emits
 * an empty path slot followed by the two path fields, and a binary file reports `-` counts — both are skipped here.
 */
function sumNumstat(output: string): { additions: number; deletions: number } {
    const fields = output.split('\0');
    let additions = 0;
    let deletions = 0;
    for (let index = 0; index < fields.length; index += 1) {
        // `[\s\S]*` (not `.*`): a legal Git filename may contain newlines, and with `-z` the raw
        // name is embedded unquoted inside this NUL field.
        const record = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(fields[index]);
        if (!record) continue;
        if (record[1] !== '-') additions += Number(record[1]);
        if (record[2] !== '-') deletions += Number(record[2]);
        // A rename/copy record carries no inline path; its two path fields follow as separate NUL fields.
        if (record[3] === '') index += 2;
    }
    return { additions, deletions };
}

interface GitServiceOptions {
    /**
     * Runtime event sink for `git.changed`; absent in focused tests.
     */
    emit?: (event: RuntimeEvent) => void;
    /**
     * Test seam forwarded to the Git metadata watcher.
     */
    subscribe?: GitMetadataWatcherOptions['subscribe'];
}

export class GitService {
    private readonly commands = new AsyncSemaphore(MAX_CONCURRENT_GIT_COMMANDS);
    private readonly histories = new SingleFlight<string, GitCommitPage>();
    private readonly repositoryService: GitRepoService;
    private readonly blameService: GitBlameService;
    private readonly pullRequestService: GitPullRequestService;
    private readonly topologyRegistry: RepoTopologyRegistry;
    private readonly changeTracker: GitChangeTracker;
    private readonly metadataWatcher: GitMetadataWatcher;

    constructor(
        private readonly paths: ProjectRootResolver,
        private readonly logger: StructuredLogger,
        options: GitServiceOptions = {},
    ) {
        this.topologyRegistry = new RepoTopologyRegistry({
            git: (cwd, arguments_) => this.git(cwd, arguments_),
        });
        this.changeTracker = new GitChangeTracker({
            emit: options.emit,
            repositoryId: computeRepoId,
        });
        this.repositoryService = new GitRepoService(this.paths, {
            git: (cwd, arguments_, options_) => this.git(cwd, arguments_, options_),
            logger: this.logger,
            topology: this.topologyRegistry,
            tracker: this.changeTracker,
        });
        this.metadataWatcher = new GitMetadataWatcher({
            logger: this.logger,
            onStatusChanged: (repoKey, roots) =>
                this.repositoryService.observeMetadataStatus(repoKey, roots),
            onTopologyChanged: (repoKey) => this.repositoryService.observeMetadataTopology(repoKey),
            subscribe: options.subscribe,
        });
        this.repositoryService.attachMetadataWatcher(this.metadataWatcher);
        this.pullRequestService = new GitPullRequestService({
            git: (cwd, arguments_, options) => this.git(cwd, arguments_, options),
            ghPullRequestView: (cwd) => this.ghPullRequestView(cwd),
            resolveRepository: (sessionId, repoId) => this.resolveRepository(sessionId, repoId),
        });
        this.blameService = new GitBlameService(this.paths, {
            git: (cwd, arguments_, options) => this.git(cwd, arguments_, options),
            summary: (sessionId) => this.summary(sessionId),
        });
    }

    private async git(
        cwd: string,
        arguments_: string[],
        options: GitCommandOptions = {},
    ): Promise<string> {
        const queuedAt = performance.now();
        return this.commands.run(async () => {
            const startedAt = performance.now();
            const timing = () => ({
                queueMs: startedAt - queuedAt,
                execMs: performance.now() - startedAt,
                repository: hashRepoPath(cwd),
            });
            try {
                const execution = execFileAsync('git', arguments_, {
                    cwd,
                    timeout: 10_000,
                    maxBuffer: options.maxBufferBytes ?? MAX_GIT_METADATA_BYTES,
                    env: { ...safeProcessEnvironment(), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
                });
                if (options.input !== undefined) {
                    /**
                     * A fast Git failure may close stdin before the bounded batch is written.
                     */
                    execution.child.stdin?.on('error', () => {});
                    execution.child.stdin?.end(options.input);
                }
                const { stdout } = await execution;
                this.logger.write('info', 'git.command', {
                    durationMs: performance.now() - queuedAt,
                    fields: { operation: classifyGitOperation(arguments_), ...timing() },
                });
                return stdout;
            } catch (error) {
                if (options.allowFailure) return '';
                this.logger.write('warn', 'git.command_failed', {
                    durationMs: performance.now() - queuedAt,
                    fields: {
                        operation: classifyGitOperation(arguments_),
                        ...timing(),
                        error: errorMessage(error, 'unknown'),
                    },
                });
                throw toGitError(error);
            }
        });
    }

    /**
     * Reads GitHub PR metadata through fixed `gh` argv without granting the Renderer CLI access.
     */
    private async ghPullRequestView(cwd: string): Promise<string> {
        const startedAt = performance.now();
        return this.commands.run(async () => {
            try {
                const { stdout } = await execFileAsync(
                    'gh',
                    [
                        'pr',
                        'view',
                        '--json',
                        'number,title,url,baseRefName,headRefName,baseRefOid,headRefOid',
                    ],
                    {
                        cwd,
                        timeout: 10_000,
                        maxBuffer: MAX_GIT_METADATA_BYTES,
                        env: { ...safeProcessEnvironment(), LC_ALL: 'C' },
                    },
                );
                this.logger.write('info', 'git.github_command', {
                    durationMs: performance.now() - startedAt,
                    fields: { operation: 'pr.view' },
                });
                return stdout;
            } catch (error) {
                // Deliberately not `NodeJS.ErrnoException` here: that type inherits `Error`'s required
                // `message: string`, but `error` is `unknown` at this catch boundary and a thrown value
                // is not guaranteed to be an `Error` instance with a `message` at runtime.
                const failure = error as { code?: string; message?: string; stderr?: string };
                const message = `${failure.message ?? ''}\n${failure.stderr ?? ''}`;
                if (/no pull requests found|could not find pull request/i.test(message)) return '';
                this.logger.write('warn', 'git.github_command_failed', {
                    durationMs: performance.now() - startedAt,
                    fields: { operation: 'pr.view', error: errorMessage(error, 'unknown') },
                });
                if (failure.code === 'ENOENT')
                    throw new CaxriError('UNAVAILABLE', 'GitHub CLI is not available on PATH');
                throw new CaxriError(
                    'GIT',
                    'Unable to load the pull request for the current branch',
                );
            }
        });
    }

    private resolveRepository(sessionId: string, repoIdValue: string): Promise<GitRepoSummary> {
        return this.repositoryService.resolveRepository(sessionId, repoIdValue);
    }

    private async listBranches(
        repo: GitRepoSummary,
    ): Promise<Array<{ name: string; committedAt: number }>> {
        // Most recently committed branches first (GitLens-style recency); the earlier
        // `--sort=refname` is the tiebreaker — with multiple keys the last one is primary.
        // `%00` keeps the name/date split unambiguous: branch names cannot contain NUL.
        const output = await this.git(repo.rootPath, [
            'for-each-ref',
            `--count=${MAX_LOCAL_BRANCHES}`,
            '--sort=refname',
            '--sort=-committerdate',
            '--format=%(refname:short)%00%(committerdate:unix)',
            'refs/heads',
        ]);
        return output
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
                const [name, committedAt] = line.split('\0', 2);
                return { name, committedAt: Number(committedAt) * 1_000 };
            });
    }

    private async resolveHistoryPath(
        repo: GitRepoSummary,
        input?: string,
    ): Promise<string | undefined> {
        if (!input || input === '.') return undefined;
        const candidate = isAbsolute(input) ? input : resolve(repo.rootPath, input);
        try {
            const stats = await lstat(candidate);
            if (stats.isSymbolicLink())
                throw new CaxriError('PATH_DENIED', 'Git history path cannot be a symlink');
            const canonical = await realpath(candidate);
            const relativePath = relative(repo.rootPath, canonical);
            assertInsideRoot(relativePath, 'Git history path is outside the selected repository');
            return relativePath || undefined;
        } catch (error) {
            // The Renderer debounces the history path filter, so partial or nonexistent input is
            // expected while the user types; surface it as NOT_FOUND rather than a generic INTERNAL
            // failure that renders as an alarming "Unable to load commits" error.
            if (isCaxriError(error)) throw error;
            if (
                error instanceof Error &&
                'code' in error &&
                (error.code === 'ENOENT' || error.code === 'ENOTDIR')
            )
                throw new CaxriError(
                    'NOT_FOUND',
                    'Git history path does not exist in the repository',
                );
            throw error;
        }
    }

    private async resolveDiffTarget(
        sessionId: string,
        repoIdValue: string,
        path: string,
    ): Promise<DiffTarget> {
        const repo = await this.resolveRepository(sessionId, repoIdValue);
        let candidate = isAbsolute(path) ? path : resolve(repo.rootPath, path);
        try {
            candidate = await realpath(candidate);
        } catch {
            /**
             * Deleted Git paths no longer resolve; the lexical path is revalidated below.
             */
        }
        const relativePath = relative(repo.rootPath, candidate);
        const outsideRepo = 'Git path is outside the selected repository';
        assertInsideRoot(relativePath, outsideRepo);
        if (!relativePath) throw new CaxriError('PATH_DENIED', outsideRepo);
        const file = repo.files.find((item) => item.path === relativePath);
        if (!file) throw new CaxriError('NOT_FOUND', 'Git change no longer exists');
        return { candidate, file, relativePath, repository: repo };
    }

    private async readWorkingTreeFile(path: string): Promise<string | undefined> {
        try {
            const content = await readFile(path);
            if (content.byteLength > MAX_CONFIGURABLE_FILE_BYTES)
                throw new CaxriError('CAPACITY', 'Git diff file exceeds the configured size limit');
            if (content.includes(0))
                throw new CaxriError('GIT', 'Binary files cannot be opened in the diff editor');
            return content.toString('utf8');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'ENOENT' || code === 'EISDIR') return undefined;
            throw error;
        }
    }

    private async loadPatch(
        repoRoot: string,
        file: GitFileStatus,
        relativePath: string,
        extraArguments: readonly string[] = [],
    ): Promise<string> {
        const chunks: string[] = [];
        if (![' ', '?'].includes(file.index)) {
            chunks.push(
                await this.git(
                    repoRoot,
                    [
                        'diff',
                        '--cached',
                        '--no-ext-diff',
                        '--no-color',
                        ...extraArguments,
                        '--',
                        relativePath,
                    ],
                    { maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES },
                ),
            );
        }
        if (![' ', '?'].includes(file.workingTree)) {
            chunks.push(
                await this.git(
                    repoRoot,
                    ['diff', '--no-ext-diff', '--no-color', ...extraArguments, '--', relativePath],
                    { maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES },
                ),
            );
        }
        return chunks.filter(Boolean).join('\n');
    }

    summary(sessionId: string, refresh = 0): Promise<GitSummary> {
        return this.repositoryService.summary(sessionId, refresh);
    }

    /**
     * Count/branch projection sharing the exact snapshot generation of `git.summary` without the `files[]` payload; it
     * joins the same producer instead of running a second `git status`.
     */
    async overview(sessionId: string): Promise<GitOverview> {
        const summary = await this.summary(sessionId);
        return {
            isRepository: summary.isRepository,
            ...(summary.error !== undefined && { error: summary.error }),
            repositories: summary.repositories.map(
                // `files` must never cross into the overview payload; destructuring it out is the
                // simplest way to drop it while keeping the rest of the projection in sync with
                // the `GitRepositorySummary` shape.
                // eslint-disable-next-line @typescript-eslint/no-unused-vars -- rest-omit pattern, see above
                ({ files: _files, ...projection }) => projection,
            ),
        };
    }

    /**
     * Working-tree change intake from the Project file watcher; maps Session-relative paths to repository identities
     * and schedules coalesced invalidation.
     */
    observeFilesChanged(payload: { sessionId: string; changes: ReadonlyArray<{ path: string }> }) {
        this.repositoryService.observeWorkingTreeChanges(
            payload.sessionId,
            payload.changes.map((change) => change.path),
        );
    }

    /**
     * Returns the canonical linked-worktree topology for one known Project repository via the shared registry.
     * Workbench flows force a fresh discovery because they must observe an Agent's `git worktree add` before any
     * watcher signal lands; the reload also refreshes the registry cache that `git.summary` consumes. This is an
     * internal Runtime boundary: discovery does not imply authorization and never reaches Renderer.
     */
    async worktreeTopology(projectRoot: string): Promise<GitWorktreeTopology> {
        const topology = await this.topologyRegistry.topology(projectRoot, { force: true });
        return {
            repositoryKey: topology.repositoryKey,
            worktrees: topology.worktrees.map(({ branch, rootPath }) => ({ branch, rootPath })),
        };
    }

    /**
     * Returns ignored direct children using one NUL-delimited Git batch for the listed directory.
     */
    async ignoredEntries(
        sessionId: string,
        directory: string,
        names: readonly string[],
    ): Promise<{ ignoredNames: ReadonlySet<string>; rulePaths: readonly string[] }> {
        const repo = await this.repositoryService.resolveDirectory(sessionId, directory);
        if (!repo) return { ignoredNames: new Set(), rulePaths: [] };
        if (names.length === 0) return { ignoredNames: new Set(), rulePaths: repo.ignoreRulePaths };
        const output = await this.git(repo.directoryPath, ['check-ignore', '--stdin', '-z'], {
            allowFailure: true,
            input: `${names.join('\0')}\0`,
        });
        return {
            ignoredNames: new Set(output.split('\0').filter(Boolean)),
            rulePaths: repo.ignoreRulePaths,
        };
    }

    async branches(
        parameters: RuntimeMethodParameters<'git.branches'>,
    ): Promise<Array<{ name: string; committedAt: number }>> {
        const repo = await this.resolveRepository(parameters.sessionId, parameters.repositoryId);
        return this.listBranches(repo);
    }

    async switchBranch(parameters: RuntimeMethodParameters<'git.switchBranch'>): Promise<null> {
        const repo = await this.resolveRepository(parameters.sessionId, parameters.repositoryId);
        const branches = await this.listBranches(repo);
        if (branches.every((candidate) => candidate.name !== parameters.branch))
            throw new CaxriError('NOT_FOUND', 'The selected local branch no longer exists');
        if (repo.branch !== parameters.branch)
            await this.git(repo.rootPath, ['switch', '--', parameters.branch]);
        return null;
    }

    pullRequestChanges(parameters: RuntimeMethodParameters<'git.pullRequestChanges'>) {
        return this.pullRequestService.changes(parameters);
    }

    pullRequestDiffDocument(parameters: RuntimeMethodParameters<'git.pullRequestDiffDocument'>) {
        return this.pullRequestService.diffDocument(parameters);
    }

    /**
     * Drops every per-Session Git retention (Pull Request file lists, repository projections, snapshots, and watchers
     * no remaining Session references) after persistence removal.
     */
    evictSessions(sessionIds: readonly string[]): void {
        this.pullRequestService.evictSessions(sessionIds);
        this.repositoryService.evictSessions(sessionIds);
    }

    /**
     * Releases retained Pull Request metadata, invalidation state, and Git metadata watchers at the Runtime lifecycle
     * boundary.
     */
    async close(): Promise<void> {
        this.pullRequestService.clear();
        this.changeTracker.close();
        await this.metadataWatcher.close();
    }

    commits(parameters: RuntimeMethodParameters<'git.commits'>): Promise<GitCommitPage> {
        return this.histories.run(JSON.stringify(parameters), async () => {
            const repo = await this.resolveRepository(
                parameters.sessionId,
                parameters.repositoryId,
            );
            if (!repo.head) return { commits: [] };
            const path = await this.resolveHistoryPath(repo, parameters.path);
            const arguments_ = [
                'log',
                '-z',
                '--date-order',
                '--full-history',
                '--decorate=short',
                `--skip=${parameters.offset}`,
                `--max-count=${parameters.pageSize + 1}`,
                `--format=${COMMIT_FORMAT}`,
            ];
            if (path) arguments_.push('--', path);
            const commits = parseCommitLog(await this.git(repo.rootPath, arguments_));
            const hasMore = commits.length > parameters.pageSize;
            return {
                commits: commits.slice(0, parameters.pageSize),
                nextOffset: hasMore ? parameters.offset + parameters.pageSize : undefined,
            };
        });
    }

    async commitDetails(
        parameters: RuntimeMethodParameters<'git.commitDetails'>,
    ): Promise<GitCommitDetails> {
        const repo = await this.resolveRepository(parameters.sessionId, parameters.repositoryId);
        const [path, commitOutput] = await Promise.all([
            this.resolveHistoryPath(repo, parameters.path),
            this.git(repo.rootPath, [
                'show',
                '-s',
                '-z',
                '--decorate=short',
                `--format=${COMMIT_FORMAT}`,
                parameters.sha,
            ]),
        ]);
        // `.at(0)` (not `[0]`) keeps the result typed as possibly missing: `git show` can return no
        // parseable commit line for a stale or unknown sha.
        const commit = parseCommitLog(commitOutput).at(0);
        if (!commit) throw new CaxriError('NOT_FOUND', 'Git commit no longer exists');
        const fileArguments = [
            'diff-tree',
            '--root',
            '--first-parent',
            '-m',
            '--no-commit-id',
            '--name-status',
            '-r',
            '-z',
            '-M',
            parameters.sha,
        ];
        if (path) fileArguments.push('--', path);
        const numstatArguments = fileArguments.map((argument) =>
            argument === '--name-status' ? '--numstat' : argument,
        );
        const [filesOutput, numstatOutput] = await Promise.all([
            this.git(repo.rootPath, fileArguments),
            this.git(repo.rootPath, numstatArguments),
        ]);
        const files = parseCommitFiles(filesOutput);
        const lineStats = sumNumstat(numstatOutput);
        return {
            commit,
            files: files.slice(0, MAX_COMMIT_FILES),
            filesTruncated: files.length > MAX_COMMIT_FILES,
            ...lineStats,
        };
    }

    blame(parameters: RuntimeMethodParameters<'git.blame'>) {
        return this.blameService.blame(parameters);
    }

    fileHead(parameters: RuntimeMethodParameters<'git.fileHead'>): Promise<GitCommit | null> {
        return this.blameService.fileHead(parameters);
    }

    /**
     * Both sides of one committed file resolved from the commit's own diff, so renames and root commits stay correct
     * without the Renderer having to submit a `previousPath`.
     */
    async commitDiffDocument(
        parameters: RuntimeMethodParameters<'git.commitDiffDocument'>,
    ): Promise<GitDiffDocument> {
        const repo = await this.resolveRepository(parameters.sessionId, parameters.repositoryId);
        const files = parseCommitFiles(
            await this.git(repo.rootPath, [
                'diff-tree',
                '--root',
                '--first-parent',
                '-m',
                '--no-commit-id',
                '--name-status',
                '-r',
                '-z',
                '-M',
                parameters.sha,
            ]),
        );
        const file = files.find((candidate) => candidate.path === parameters.path);
        if (!file) throw new CaxriError('NOT_FOUND', 'File is not part of this commit');
        // No `allowFailure` here: only a genuinely absent side (added/deleted file) is legitimately
        // empty; an oversized blob or failing `git show` must surface as an error, not a blank diff.
        const showOptions = { maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES };
        const originalPath = file.previousPath ?? file.path;
        const [original, modified] = await Promise.all([
            file.status === 'added'
                ? Promise.resolve('')
                : this.git(
                      repo.rootPath,
                      ['show', `${parameters.sha}^:${originalPath}`],
                      showOptions,
                  ),
            file.status === 'deleted'
                ? Promise.resolve('')
                : this.git(repo.rootPath, ['show', `${parameters.sha}:${file.path}`], showOptions),
        ]);
        // Binary blobs must never reach the text diff editor as mojibake; fall back to Git's own
        // bounded patch output ("Binary files ... differ"), mirroring the working-tree patch path.
        if (original.includes('\0') || modified.includes('\0')) {
            const patch = await this.git(
                repo.rootPath,
                ['show', '-M', '--format=', '--patch', parameters.sha, '--', file.path],
                showOptions,
            );
            return {
                format: 'patch',
                path: file.path,
                originalPath: file.previousPath,
                original: '',
                modified: patch,
            };
        }
        return {
            format: 'contents',
            path: file.path,
            originalPath: file.previousPath,
            original,
            modified,
        };
    }

    async diffDocument(
        sessionId: string,
        repoIdValue: string,
        path: string,
    ): Promise<GitDiffDocument> {
        const { candidate, file, relativePath, repository } = await this.resolveDiffTarget(
            sessionId,
            repoIdValue,
            path,
        );
        const workingTreeContent = await this.readWorkingTreeFile(candidate);
        if (workingTreeContent === undefined && file.kind !== 'deleted') {
            const patch = await this.loadPatch(repository.rootPath, file, relativePath, [
                '--submodule=short',
            ]);
            if (patch)
                return {
                    format: 'patch',
                    path: relativePath,
                    originalPath: file.originalPath,
                    original: '',
                    modified: patch,
                };
        }
        const originalPath = file.originalPath ?? relativePath;
        const original =
            file.kind === 'untracked'
                ? ''
                : await this.git(repository.rootPath, ['show', `HEAD:${originalPath}`], {
                      allowFailure: true,
                      maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES,
                  });
        return {
            format: 'contents',
            path: relativePath,
            originalPath: file.originalPath,
            original,
            modified: workingTreeContent ?? '',
        };
    }
}
