import { execFile } from 'node:child_process';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../../shared/ipc/domain';
import { CaxriError, errorMessage, isCaxriError } from '../../shared/ipc/errors';
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
    GitRepositorySummary,
    GitSummary,
} from '../../shared/types';
import type { RuntimeMethodParams } from '../../shared/ipc/methods';
import { assertInsideRoot } from '../path-security';
import { SingleFlight } from '../single-flight';
import type { ProjectRootResolver } from '../project-roots';
import { GitBlameService } from './blame';
import { toGitError } from './errors';
import { GitPullRequestService } from './pull-request';
import { GitRepositoryService, parseWorktreeEntries } from './repository';

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
    repository: GitRepositorySummary;
}

export interface GitWorktreeTopology {
    repositoryKey: string;
    worktrees: Array<{ branch: string; rootPath: string }>;
}
export { describeGitFailure } from './errors';

const COMMIT_FORMAT = '%H%x00%an%x00%at%x00%P%x00%D%x00%s%x00';

/** Parses fixed-width NUL fields emitted by `git log -z`, including non-ASCII subjects. */
function parseCommitLog(output: string): GitCommit[] {
    const fields = output.split('\0');
    const commits: GitCommit[] = [];
    for (let index = 0; index < fields.length && fields[index];) {
        const sha = fields[index++].replace(/^\n+/, '');
        const author = fields[index++];
        const authoredAt = fields[index++];
        const parents = fields[index++] ?? '';
        const decorations = fields[index++] ?? '';
        const subject = fields[index++] ?? '';
        const terminator = fields[index++];
        if (!/^[0-9a-f]{40}$/.test(sha) || !/^\d+$/.test(authoredAt) || terminator !== '')
            throw new CaxriError('GIT', 'Git returned malformed commit history');
        commits.push({
            sha,
            shortSha: sha.slice(0, 7),
            subject: subject.slice(0, 4_096),
            author: author.slice(0, 1_024),
            authoredAt: Number(authoredAt) * 1_000,
            decorations: decorations
                .split(', ')
                .map((value) => value.trim())
                .filter(Boolean)
                .slice(0, 50)
                .map((value) => value.slice(0, 1_024)),
            parents: parents.split(' ').filter(Boolean).slice(0, 64),
        });
    }
    return commits;
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

export class GitService {
    private readonly commands = new AsyncSemaphore(MAX_CONCURRENT_GIT_COMMANDS);
    private readonly histories = new SingleFlight<string, GitCommitPage>();
    private readonly repositoryService: GitRepositoryService;
    private readonly blameService: GitBlameService;
    private readonly pullRequestService: GitPullRequestService;

    constructor(
        private readonly paths: ProjectRootResolver,
        private readonly logger: StructuredLogger,
    ) {
        this.repositoryService = new GitRepositoryService(this.paths, {
            git: (cwd, args, options) => this.git(cwd, args, options),
        });
        this.pullRequestService = new GitPullRequestService({
            git: (cwd, args, options) => this.git(cwd, args, options),
            ghPullRequestView: (cwd) => this.ghPullRequestView(cwd),
            resolveRepository: (sessionId, repositoryId) =>
                this.resolveRepository(sessionId, repositoryId),
        });
        this.blameService = new GitBlameService(this.paths, {
            git: (cwd, args, options) => this.git(cwd, args, options),
            summary: (sessionId) => this.summary(sessionId),
        });
    }

    private async git(
        cwd: string,
        args: string[],
        options: GitCommandOptions = {},
    ): Promise<string> {
        const startedAt = performance.now();
        return this.commands.run(async () => {
            try {
                const execution = execFileAsync('git', args, {
                    cwd,
                    timeout: 10_000,
                    maxBuffer: options.maxBufferBytes ?? MAX_GIT_METADATA_BYTES,
                    env: { ...safeProcessEnvironment(), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
                });
                if (options.input !== undefined) {
                    /** A fast Git failure may close stdin before the bounded batch is written. */
                    execution.child.stdin?.on('error', () => undefined);
                    execution.child.stdin?.end(options.input);
                }
                const { stdout } = await execution;
                this.logger.write('info', 'git.command', {
                    durationMs: performance.now() - startedAt,
                    fields: { operation: args[0] ?? 'unknown' },
                });
                return stdout;
            } catch (error) {
                if (options.allowFailure) return '';
                this.logger.write('warn', 'git.command_failed', {
                    durationMs: performance.now() - startedAt,
                    fields: {
                        operation: args[0] ?? 'unknown',
                        error: errorMessage(error, 'unknown'),
                    },
                });
                throw toGitError(error);
            }
        });
    }

    /** Reads GitHub PR metadata through fixed `gh` argv without granting the Renderer CLI access. */
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
                const failure = error as NodeJS.ErrnoException & { stderr?: string };
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

    summary(sessionId: string): Promise<GitSummary> {
        return this.repositoryService.summary(sessionId);
    }

    /**
     * Returns the canonical linked-worktree topology for one known Project repository. This is an
     * internal Runtime boundary: discovery does not imply authorization and never reaches Renderer.
     */
    async worktreeTopology(projectRoot: string): Promise<GitWorktreeTopology> {
        const root = await realpath(projectRoot);
        const [commonDirectoryOutput, worktreeOutput] = await Promise.all([
            this.git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
            this.git(root, ['worktree', 'list', '--porcelain', '-z']),
        ]);
        const repositoryKey = await realpath(commonDirectoryOutput.trim());
        const worktrees = (
            await Promise.all(
                parseWorktreeEntries(worktreeOutput).map(async (entry) => {
                    try {
                        const rootPath = await realpath(entry.rootPath);
                        const stats = await lstat(rootPath);
                        return stats.isDirectory() && !stats.isSymbolicLink()
                            ? [{ ...entry, rootPath }]
                            : [];
                    } catch {
                        return [];
                    }
                }),
            )
        ).flat();
        return { repositoryKey, worktrees };
    }

    /** Returns ignored direct children using one NUL-delimited Git batch for the listed directory. */
    async ignoredEntries(
        sessionId: string,
        directory: string,
        names: readonly string[],
    ): Promise<{ ignoredNames: ReadonlySet<string>; rulePaths: readonly string[] }> {
        const repository = await this.repositoryService.resolveDirectory(sessionId, directory);
        if (!repository) return { ignoredNames: new Set(), rulePaths: [] };
        if (names.length === 0)
            return { ignoredNames: new Set(), rulePaths: repository.ignoreRulePaths };
        const output = await this.git(repository.directoryPath, ['check-ignore', '--stdin', '-z'], {
            allowFailure: true,
            input: `${names.join('\0')}\0`,
        });
        return {
            ignoredNames: new Set(output.split('\0').filter(Boolean)),
            rulePaths: repository.ignoreRulePaths,
        };
    }

    private resolveRepository(
        sessionId: string,
        repositoryIdValue: string,
    ): Promise<GitRepositorySummary> {
        return this.repositoryService.resolveRepository(sessionId, repositoryIdValue);
    }

    private async listBranches(repository: GitRepositorySummary): Promise<string[]> {
        const output = await this.git(repository.rootPath, [
            'for-each-ref',
            `--count=${MAX_LOCAL_BRANCHES}`,
            '--format=%(refname:short)',
            'refs/heads',
        ]);
        return output
            .split('\n')
            .map((branch) => branch.trim())
            .filter(Boolean);
    }

    async branches(params: RuntimeMethodParams<'git.branches'>): Promise<string[]> {
        const repository = await this.resolveRepository(params.sessionId, params.repositoryId);
        return this.listBranches(repository);
    }

    async switchBranch(params: RuntimeMethodParams<'git.switchBranch'>): Promise<null> {
        const repository = await this.resolveRepository(params.sessionId, params.repositoryId);
        const branches = await this.listBranches(repository);
        if (!branches.includes(params.branch))
            throw new CaxriError('NOT_FOUND', 'The selected local branch no longer exists');
        if (repository.branch !== params.branch)
            await this.git(repository.rootPath, ['switch', '--', params.branch]);
        return null;
    }

    pullRequestChanges(params: RuntimeMethodParams<'git.pullRequestChanges'>) {
        return this.pullRequestService.changes(params);
    }

    pullRequestDiffDocument(params: RuntimeMethodParams<'git.pullRequestDiffDocument'>) {
        return this.pullRequestService.diffDocument(params);
    }

    private async resolveHistoryPath(
        repository: GitRepositorySummary,
        input?: string,
    ): Promise<string | undefined> {
        if (!input || input === '.') return undefined;
        const candidate = isAbsolute(input) ? input : resolve(repository.rootPath, input);
        try {
            const stats = await lstat(candidate);
            if (stats.isSymbolicLink())
                throw new CaxriError('PATH_DENIED', 'Git history path cannot be a symlink');
            const canonical = await realpath(candidate);
            const relativePath = relative(repository.rootPath, canonical);
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

    commits(params: RuntimeMethodParams<'git.commits'>): Promise<GitCommitPage> {
        return this.histories.run(JSON.stringify(params), async () => {
            const repository = await this.resolveRepository(params.sessionId, params.repositoryId);
            if (!repository.head) return { commits: [] };
            const path = await this.resolveHistoryPath(repository, params.path);
            const args = [
                'log',
                '-z',
                '--date-order',
                '--full-history',
                '--decorate=short',
                `--skip=${params.offset}`,
                `--max-count=${params.pageSize + 1}`,
                `--format=${COMMIT_FORMAT}`,
            ];
            if (path) args.push('--', path);
            const commits = parseCommitLog(await this.git(repository.rootPath, args));
            const hasMore = commits.length > params.pageSize;
            return {
                commits: commits.slice(0, params.pageSize),
                nextOffset: hasMore ? params.offset + params.pageSize : undefined,
            };
        });
    }

    async commitDetails(
        params: RuntimeMethodParams<'git.commitDetails'>,
    ): Promise<GitCommitDetails> {
        const repository = await this.resolveRepository(params.sessionId, params.repositoryId);
        const [path, commitOutput] = await Promise.all([
            this.resolveHistoryPath(repository, params.path),
            this.git(repository.rootPath, [
                'show',
                '-s',
                '-z',
                '--decorate=short',
                `--format=${COMMIT_FORMAT}`,
                params.sha,
            ]),
        ]);
        const commit = parseCommitLog(commitOutput)[0];
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
            params.sha,
        ];
        if (path) fileArguments.push('--', path);
        const files = parseCommitFiles(await this.git(repository.rootPath, fileArguments));
        return {
            commit,
            files: files.slice(0, MAX_COMMIT_FILES),
            filesTruncated: files.length > MAX_COMMIT_FILES,
        };
    }

    blame(params: RuntimeMethodParams<'git.blame'>) {
        return this.blameService.blame(params);
    }

    private async resolveDiffTarget(
        sessionId: string,
        repositoryIdValue: string,
        path: string,
    ): Promise<DiffTarget> {
        const repository = await this.resolveRepository(sessionId, repositoryIdValue);
        let candidate = isAbsolute(path) ? path : resolve(repository.rootPath, path);
        try {
            candidate = await realpath(candidate);
        } catch {
            /** Deleted Git paths no longer resolve; the lexical path is revalidated below. */
        }
        const relativePath = relative(repository.rootPath, candidate);
        const outsideRepository = 'Git path is outside the selected repository';
        assertInsideRoot(relativePath, outsideRepository);
        if (!relativePath) throw new CaxriError('PATH_DENIED', outsideRepository);
        const file = repository.files.find((item) => item.path === relativePath);
        if (!file) throw new CaxriError('NOT_FOUND', 'Git change no longer exists');
        return { candidate, file, relativePath, repository };
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

    async diff(sessionId: string, repositoryIdValue: string, path: string): Promise<string> {
        const { file, relativePath, repository } = await this.resolveDiffTarget(
            sessionId,
            repositoryIdValue,
            path,
        );
        if (file?.kind === 'untracked')
            return 'Untracked file. Caxri does not include file contents in a synthetic diff.';
        return this.loadPatch(repository.rootPath, file, relativePath);
    }

    private async loadPatch(
        repositoryRoot: string,
        file: GitFileStatus,
        relativePath: string,
        extraArguments: readonly string[] = [],
    ): Promise<string> {
        const chunks: string[] = [];
        if (![' ', '?'].includes(file.index)) {
            chunks.push(
                await this.git(
                    repositoryRoot,
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
                    repositoryRoot,
                    ['diff', '--no-ext-diff', '--no-color', ...extraArguments, '--', relativePath],
                    { maxBufferBytes: MAX_CONFIGURABLE_FILE_BYTES },
                ),
            );
        }
        return chunks.filter(Boolean).join('\n');
    }

    async diffDocument(
        sessionId: string,
        repositoryIdValue: string,
        path: string,
    ): Promise<GitDiffDocument> {
        const { candidate, file, relativePath, repository } = await this.resolveDiffTarget(
            sessionId,
            repositoryIdValue,
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
