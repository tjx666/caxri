import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

import type {
    GitCommit,
    GitCommitDetails,
    GitCommitPage,
    GitDiffDocument,
    GitFileStatus,
    GitOverview,
    GitRepositorySummary as GitRepoSummary,
    GitSummary,
    ServerEvent,
    ServerOperationParameters,
} from '@caxri/protocol';
import {
    CaxriError,
    errorMessage,
    isCaxriError,
    MAX_CONFIGURABLE_FILE_BYTES,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import {
    AsyncSemaphore,
    execFileAsync,
    logEventCatalog,
    safeProcessEnvironment,
} from '@caxri/system';

import { runExternalCommand } from '../executables';
import { assertInsideRoot } from '../path-security';
import type { ProjectRootResolver } from '../project-roots';
import { SingleFlight } from '../single-flight';
import { GitBlameService } from './blame';
import { GitChangeTracker } from './change-tracker';
import { parseCommitFiles, sumCommitNumstat } from './commit-details';
import { COMMIT_FORMAT, parseCommitLog } from './commit-log';
import { toGitError } from './errors';
import type { GitMetadataWatcherOptions } from './metadata-watcher';
import { GitMetadataWatcher } from './metadata-watcher';
import { GitPullRequestService } from './pull-request';
import { parseGitRemoteHost } from './remote-host';
import { computeRepoId, GitRepoService } from './repo';
import { gitSignalOptions, sharedGitRequest } from './request-signal';
import { RepoTopologyRegistry } from './topology';
import { GitWorkingTreeService } from './working-tree';

const MAX_CONCURRENT_GIT_COMMANDS = 8;
const MAX_GIT_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_COMMIT_FILES = 500;
const MAX_LOCAL_BRANCHES = 1_000;

interface GitCommandOptions {
    allowFailure?: boolean;
    input?: string;
    maxBufferBytes?: number;
    /**
     * Override for network-bound operations (fetch/pull/push), which can legitimately outlast the 10s default that
     * bounds local metadata commands.
     */
    timeoutMs?: number;
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
export { withGitRequestSignal } from './request-signal';

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

interface GitServiceOptions {
    /**
     * Server event sink for `git.changed`; absent in focused tests.
     */
    emit?: (event: ServerEvent) => void;
    /**
     * Test seam forwarded to the Git metadata watcher.
     */
    subscribe?: GitMetadataWatcherOptions['subscribe'];
    /**
     * Shared Server watch registry forwarded to the Git metadata watcher.
     */
    watchHub?: GitMetadataWatcherOptions['watchHub'];
}

export class GitService {
    private readonly commands = new AsyncSemaphore(MAX_CONCURRENT_GIT_COMMANDS);
    private readonly histories = new SingleFlight<string, GitCommitPage>();
    private readonly repositoryService: GitRepoService;
    private readonly blameService: GitBlameService;
    private readonly workingTreeService: GitWorkingTreeService;
    private readonly pullRequestService: GitPullRequestService;
    private readonly topologyRegistry: RepoTopologyRegistry;
    private readonly changeTracker: GitChangeTracker;
    private readonly metadataWatcher: GitMetadataWatcher;
    /**
     * `origin` remote host per repository root, resolved once and kept for the Server's lifetime: the commit-avatar
     * privacy gate (`git.remoteHost`) must never re-spawn Git on every commit row render, and a remote host changing
     * mid-session is rare enough that a Server restart picking it up is an acceptable trade-off.
     */
    private readonly remoteHostByRoot = new Map<string, string | null>();
    private readonly remoteHostRequests = new SingleFlight<string, string | null>();

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
            watchHub: options.watchHub,
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
        this.workingTreeService = new GitWorkingTreeService({
            git: (cwd, arguments_, options_) => this.git(cwd, arguments_, options_),
            /**
             * Mutations advance Server's authoritative generation immediately. The metadata watcher may report the same
             * change later, but Source Control and other Git consumers must not depend on watcher timing.
             */
            onDidMutate: (rootPath) => this.repositoryService.observeWorkingTreeMutation(rootPath),
            resolveRepository: (sessionId, repoId) => this.resolveRepository(sessionId, repoId),
            snapshot: (sessionId, repoId) =>
                this.repositoryService.discardSnapshot(sessionId, repoId),
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
                    timeout: options.timeoutMs ?? 10_000,
                    maxBuffer: options.maxBufferBytes ?? MAX_GIT_METADATA_BYTES,
                    ...gitSignalOptions(),
                    // GIT_TERMINAL_PROMPT=0 makes a credential-less fetch/pull/push fail fast
                    // instead of hanging on a hidden terminal prompt until the timeout.
                    env: {
                        ...safeProcessEnvironment(),
                        GIT_OPTIONAL_LOCKS: '0',
                        GIT_TERMINAL_PROMPT: '0',
                        LC_ALL: 'C',
                    },
                });
                if (options.input !== undefined) {
                    /**
                     * A fast Git failure may close stdin before the bounded batch is written.
                     */
                    execution.child.stdin?.on('error', () => {});
                    execution.child.stdin?.end(options.input);
                }
                const { stdout } = await execution;
                this.logger.write('info', logEventCatalog.git.command, {
                    durationMs: performance.now() - queuedAt,
                    fields: { operation: classifyGitOperation(arguments_), ...timing() },
                });
                return stdout;
            } catch (error) {
                if (options.allowFailure) return '';
                this.logger.write('warn', logEventCatalog.git.commandFailed, {
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
                // `runExternalCommand` (not a bare `gh` spawn): the packaged GUI app inherits the
                // constrained launchd PATH without Homebrew directories, so `gh` must be resolved
                // through the login-shell PATH boundary like every other external CLI.
                const { stdout } = await runExternalCommand(
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
                        ...gitSignalOptions(),
                        env: { LC_ALL: 'C' },
                    },
                );
                this.logger.write('info', logEventCatalog.git.githubCommand, {
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
                this.logger.write('warn', logEventCatalog.git.githubCommandFailed, {
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
     * internal Server boundary: discovery does not imply authorization and never reaches Renderer.
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
        parameters: ServerOperationParameters<'git.branches'>,
    ): Promise<Array<{ name: string; committedAt: number }>> {
        const repo = await this.resolveRepository(parameters.sessionId, parameters.repositoryId);
        return this.listBranches(repo);
    }

    async switchBranch(parameters: ServerOperationParameters<'git.switchBranch'>): Promise<null> {
        const repo = await this.resolveRepository(parameters.sessionId, parameters.repositoryId);
        const branches = await this.listBranches(repo);
        if (branches.every((candidate) => candidate.name !== parameters.branch))
            throw new CaxriError('NOT_FOUND', 'The selected local branch no longer exists');
        if (repo.branch !== parameters.branch)
            await this.git(repo.rootPath, ['switch', '--', parameters.branch]);
        return null;
    }
    sync(parameters: ServerOperationParameters<'git.sync'>): Promise<null> {
        return this.workingTreeService.sync(parameters);
    }
    discardPreflight(
        parameters: ServerOperationParameters<'git.discard.preflight'>,
    ): ReturnType<GitWorkingTreeService['discardPreflight']> {
        return this.workingTreeService.discardPreflight(parameters);
    }
    discardApply(
        parameters: ServerOperationParameters<'git.discard.apply'>,
    ): ReturnType<GitWorkingTreeService['discardApply']> {
        return this.workingTreeService.discardApply(parameters);
    }
    pullRequestChanges(parameters: ServerOperationParameters<'git.pullRequestChanges'>) {
        return this.pullRequestService.changes(parameters);
    }
    /**
     * Best-effort `origin` remote host for the commit-avatar privacy gate. Reads local Git config only (`remote
     * get-url`, never a network call) and caches the result per repository root so repeated Git panel renders cost zero
     * extra Git spawns.
     */
    async remoteHost(
        parameters: ServerOperationParameters<'git.remoteHost'>,
    ): Promise<string | null> {
        const repo = await this.resolveRepository(parameters.sessionId, parameters.repositoryId);
        const cached = this.remoteHostByRoot.get(repo.rootPath);
        if (cached !== undefined) return cached;
        return sharedGitRequest(() =>
            this.remoteHostRequests.run(repo.rootPath, async () => {
                const output = await this.git(repo.rootPath, ['remote', 'get-url', 'origin'], {
                    allowFailure: true,
                });
                const host = parseGitRemoteHost(output);
                this.remoteHostByRoot.set(repo.rootPath, host);
                return host;
            }),
        );
    }

    pullRequestDiffDocument(parameters: ServerOperationParameters<'git.pullRequestDiffDocument'>) {
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
     * Releases retained Pull Request metadata, invalidation state, and Git metadata watchers at the Server lifecycle
     * boundary.
     */
    async close(): Promise<void> {
        this.pullRequestService.clear();
        this.remoteHostByRoot.clear();
        this.changeTracker.close();
        await this.metadataWatcher.close();
    }

    commits(parameters: ServerOperationParameters<'git.commits'>): Promise<GitCommitPage> {
        return sharedGitRequest(() =>
            this.histories.run(JSON.stringify(parameters), async () => {
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
            }),
        );
    }

    async commitDetails(
        parameters: ServerOperationParameters<'git.commitDetails'>,
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
        const lineStats = sumCommitNumstat(numstatOutput);
        return {
            commit,
            files: files.slice(0, MAX_COMMIT_FILES),
            filesTruncated: files.length > MAX_COMMIT_FILES,
            ...lineStats,
        };
    }

    blame(parameters: ServerOperationParameters<'git.blame'>) {
        return this.blameService.blame(parameters);
    }

    fileHead(parameters: ServerOperationParameters<'git.fileHead'>): Promise<GitCommit | null> {
        return this.blameService.fileHead(parameters);
    }

    /**
     * Both sides of one committed file resolved from the commit's own diff, so renames and root commits stay correct
     * without the Renderer having to submit a `previousPath`.
     */
    async commitDiffDocument(
        parameters: ServerOperationParameters<'git.commitDiffDocument'>,
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
