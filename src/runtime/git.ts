import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../shared/ipc/domain';
import { CaxriError, errorMessage, isCaxriError } from '../shared/ipc/errors';
import { AsyncSemaphore, mapWithConcurrency } from '../shared/node/concurrency';
import type { StructuredLogger } from '../shared/node/logger';
import { safeProcessEnvironment } from '../shared/node/process-environment';
import type {
    GitCommit,
    GitCommitDetails,
    GitCommitFile,
    GitCommitPage,
    GitDiffDocument,
    GitFileStatus,
    GitRepositorySummary,
    GitSummary,
} from '../shared/types';
import type { RuntimeMethodParams } from '../shared/ipc/methods';
import { assertInsideRoot, isOutsideRoot } from './path-security';
import { toGitError } from './git-errors';
import { GitPullRequestService } from './git-pull-request';
import { GitBlameService } from './git-blame';
import { SingleFlight } from './single-flight';
import type { ProjectRootResolver } from './project-roots';

const execFileAsync = promisify(execFile);
const MAX_CONCURRENT_GIT_COMMANDS = 8;
const MAX_GIT_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_COMMIT_FILES = 500;
const MAX_LOCAL_BRANCHES = 1_000;
interface RepositoryStatus {
    branch: string;
    head?: string;
    ahead: number;
    behind: number;
    additions: number;
    deletions: number;
    files: GitFileStatus[];
}

interface RepositoryRoot {
    kind: GitRepositorySummary['kind'];
    rootPath: string;
}

interface DiffTarget {
    candidate: string;
    file: GitFileStatus;
    relativePath: string;
    repository: GitRepositorySummary;
}
export { describeGitFailure } from './git-errors';

function statusKind(code: string): GitFileStatus['kind'] {
    if (code.includes('U') || code === 'AA' || code === 'DD') return 'conflicted';
    if (code.includes('R')) return 'renamed';
    if (code.includes('D')) return 'deleted';
    if (code.includes('A')) return 'added';
    return 'modified';
}

function parseStatusRecord(
    record: string,
    originalPath?: string,
):
    | {
          code: string;
          path: string;
          originalPath?: string;
          kind?: GitFileStatus['kind'];
      }
    | undefined {
    if (record.startsWith('? ')) return { code: '??', path: record.slice(2), kind: 'untracked' };
    const ordinary = /^1 (\S{2})(?: \S+){6} (.+)$/.exec(record);
    if (ordinary) return { code: ordinary[1], path: ordinary[2] };
    const renamed = /^2 (\S{2})(?: \S+){7} (.+)$/.exec(record);
    if (renamed) return { code: renamed[1], path: renamed[2], originalPath, kind: 'renamed' };
    const conflicted = /^u (\S{2})(?: \S+){8} (.+)$/.exec(record);
    if (conflicted) return { code: conflicted[1], path: conflicted[2], kind: 'conflicted' };
    return undefined;
}

function parseStatus(output: string): Omit<RepositoryStatus, 'additions' | 'deletions'> {
    const records = output.split('\0').filter(Boolean);
    const files: GitFileStatus[] = [];
    let branch = 'detached';
    let head: string | undefined;
    let ahead = 0;
    let behind = 0;
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        if (record.startsWith('# branch.head ')) {
            branch = record.slice('# branch.head '.length);
            continue;
        }
        if (record.startsWith('# branch.oid ')) {
            const oid = record.slice('# branch.oid '.length);
            head = oid === '(initial)' ? undefined : oid.slice(0, 7);
            continue;
        }
        if (record.startsWith('# branch.ab ')) {
            const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(record);
            ahead = Number(match?.[1] ?? 0);
            behind = Number(match?.[2] ?? 0);
            continue;
        }
        const parsed = parseStatusRecord(
            record,
            record.startsWith('2 ') ? records[index + 1] : undefined,
        );
        if (!parsed) continue;
        const code = parsed.code.replaceAll('.', ' ');
        files.push({
            path: parsed.path,
            originalPath: parsed.originalPath,
            index: code[0],
            workingTree: code[1],
            kind: parsed.kind ?? (code === '??' ? 'untracked' : statusKind(code)),
        });
        if (record.startsWith('2 ')) index += 1;
    }
    return { branch, head, ahead, behind, files };
}

function parseLineStats(output: string): Pick<RepositoryStatus, 'additions' | 'deletions'> {
    let additions = 0;
    let deletions = 0;
    for (const line of output.split('\n')) {
        const [added, deleted] = line.split('\t', 2);
        if (/^\d+$/.test(added)) additions += Number(added);
        if (/^\d+$/.test(deleted)) deletions += Number(deleted);
    }
    return { additions, deletions };
}

function parseWorktreeRoots(output: string): string[] {
    return output
        .split('\0\0')
        .flatMap((block) => block.split('\0'))
        .filter((field) => field.startsWith('worktree '))
        .map((field) => field.slice('worktree '.length));
}

function parseGitLinkPaths(output: string): string[] {
    return output
        .split('\0')
        .map((record) => /^160000 [0-9a-f]+ \d+\t(.+)$/.exec(record)?.[1])
        .filter((path): path is string => Boolean(path));
}

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

function repositoryId(rootPath: string): string {
    return createHash('sha256').update(rootPath).digest('hex').slice(0, 20);
}

function containsPath(rootPath: string, candidate: string): boolean {
    return !isOutsideRoot(relative(rootPath, candidate));
}

function isApproved(rootPath: string, approvedRoots: string[]): boolean {
    return approvedRoots.some((approvedRoot) => containsPath(approvedRoot, rootPath));
}

function hidesChildRepository(
    filePath: string,
    child: Pick<RepositoryRoot, 'kind' | 'rootPath'>,
    parentRootPath: string,
): boolean {
    const childPath = relative(parentRootPath, child.rootPath);
    const normalizedChild = childPath.endsWith(sep) ? childPath.slice(0, -1) : childPath;
    const normalizedFile = filePath.endsWith(sep) ? filePath.slice(0, -1) : filePath;
    if (child.kind === 'submodule' && normalizedFile === normalizedChild) return false;
    return (
        normalizedFile === normalizedChild || normalizedFile.startsWith(`${normalizedChild}${sep}`)
    );
}

export class GitService {
    private readonly commands = new AsyncSemaphore(MAX_CONCURRENT_GIT_COMMANDS);
    private readonly summaries = new SingleFlight<string, GitSummary>();
    private readonly histories = new SingleFlight<string, GitCommitPage>();
    private readonly blameService: GitBlameService;
    private readonly pullRequestService: GitPullRequestService;

    constructor(
        private readonly paths: ProjectRootResolver,
        private readonly logger: StructuredLogger,
    ) {
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
        options: { allowFailure?: boolean; maxBufferBytes?: number } = {},
    ): Promise<string> {
        const startedAt = performance.now();
        return this.commands.run(async () => {
            try {
                const { stdout } = await execFileAsync('git', args, {
                    cwd,
                    timeout: 10_000,
                    maxBuffer: options.maxBufferBytes ?? MAX_GIT_METADATA_BYTES,
                    env: { ...safeProcessEnvironment(), GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
                });
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

    private async loadStatus(rootPath: string): Promise<RepositoryStatus> {
        const [status, lineStats] = await Promise.all([
            this.git(rootPath, [
                'status',
                '--porcelain=v2',
                '--branch',
                '-z',
                '--untracked-files=all',
            ]).then(parseStatus),
            this.git(rootPath, ['diff', '--numstat', '--no-renames', 'HEAD', '--'], {
                allowFailure: true,
            }).then(parseLineStats),
        ]);
        return { ...status, ...lineStats };
    }

    private async canonicalRepositoryRoot(path: string): Promise<string | undefined> {
        try {
            const canonical = await realpath(path);
            const topLevel = await realpath(
                (await this.git(canonical, ['rev-parse', '--show-toplevel'])).trim(),
            );
            return topLevel === canonical ? canonical : undefined;
        } catch {
            return undefined;
        }
    }

    private async discoverChildRepositories(
        parent: RepositoryRoot,
        approvedRoots: string[],
    ): Promise<RepositoryRoot[]> {
        const [gitLinkOutput, untrackedDirectoryOutput] = await Promise.all([
            this.git(parent.rootPath, ['ls-files', '--stage', '-z']),
            this.git(parent.rootPath, [
                'ls-files',
                '--others',
                '--directory',
                '--exclude-standard',
                '-z',
            ]),
        ]);
        const nestedCandidates = await mapWithConcurrency(
            untrackedDirectoryOutput.split('\0').filter((path) => path.endsWith('/')),
            MAX_CONCURRENT_GIT_COMMANDS,
            async (path) => {
                const candidate = resolve(parent.rootPath, path);
                try {
                    const marker = await lstat(resolve(candidate, '.git'));
                    if (marker.isSymbolicLink()) return undefined;
                    return candidate;
                } catch {
                    return undefined;
                }
            },
        );
        const candidates = [
            ...parseGitLinkPaths(gitLinkOutput).map((path) => ({
                kind: 'submodule' as const,
                path: resolve(parent.rootPath, path),
            })),
            ...nestedCandidates
                .filter((path): path is string => Boolean(path))
                .map((path) => ({ kind: 'nested' as const, path })),
        ];
        const discovered = await mapWithConcurrency(
            candidates,
            MAX_CONCURRENT_GIT_COMMANDS,
            async (candidate): Promise<RepositoryRoot | undefined> => {
                const rootPath = await this.canonicalRepositoryRoot(candidate.path);
                if (!rootPath || !isApproved(rootPath, approvedRoots)) return undefined;
                return { kind: candidate.kind, rootPath };
            },
        );
        return discovered.filter((value): value is RepositoryRoot => Boolean(value));
    }

    async summary(sessionId: string): Promise<GitSummary> {
        return this.summaries.run(sessionId, () => this.loadSummary(sessionId));
    }

    private async resolveRepository(
        sessionId: string,
        repositoryIdValue: string,
    ): Promise<GitRepositorySummary> {
        const summary = await this.summary(sessionId);
        const repository = summary.repositories.find(
            (candidate) => candidate.id === repositoryIdValue,
        );
        if (!repository)
            throw new CaxriError(
                'PATH_DENIED',
                'Git repository is outside the approved Project roots',
            );
        return repository;
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

    private async loadSummary(sessionId: string): Promise<GitSummary> {
        const { root: projectRoot } = await this.paths.resolveSessionPath(sessionId);
        try {
            const approvedRoots = (
                await Promise.all(
                    this.paths.listApprovedProjectRoots().map(async (path) => {
                        try {
                            return await realpath(path);
                        } catch {
                            return undefined;
                        }
                    }),
                )
            ).filter((path): path is string => Boolean(path));
            const primaryRoot = await this.canonicalRepositoryRoot(projectRoot);
            if (!primaryRoot || !isApproved(primaryRoot, approvedRoots))
                throw Object.assign(new Error('not a git repository'), {
                    stderr: 'not a git repository within an approved Project root',
                });
            const worktreeOutput = await this.git(primaryRoot, [
                'worktree',
                'list',
                '--porcelain',
                '-z',
            ]);
            const worktreeRoots = await Promise.all(
                parseWorktreeRoots(worktreeOutput).map((path) =>
                    this.canonicalRepositoryRoot(path),
                ),
            );
            const baseRepositories: RepositoryRoot[] = [
                { kind: 'primary', rootPath: primaryRoot },
                ...worktreeRoots
                    .filter(
                        (path): path is string =>
                            path !== undefined &&
                            path !== primaryRoot &&
                            isApproved(path, approvedRoots),
                    )
                    .map((rootPath) => ({ kind: 'worktree' as const, rootPath })),
            ];
            const baseStatuses = await Promise.all(
                baseRepositories.map((repository) => this.loadStatus(repository.rootPath)),
            );
            const children = (
                await Promise.all(
                    baseRepositories.map((repository) =>
                        this.discoverChildRepositories(repository, approvedRoots),
                    ),
                )
            ).flat();
            const roots = [...baseRepositories, ...children].filter(
                (repository, index, repositories) =>
                    repositories.findIndex(
                        (candidate) => candidate.rootPath === repository.rootPath,
                    ) === index,
            );
            const childStatuses = await Promise.all(
                roots
                    .slice(baseRepositories.length)
                    .map((repository) => this.loadStatus(repository.rootPath)),
            );
            const statuses = [...baseStatuses, ...childStatuses];
            const repositories = roots.map((repository, index): GitRepositorySummary => {
                const children = roots.filter(
                    (candidate) =>
                        candidate.rootPath !== repository.rootPath &&
                        containsPath(repository.rootPath, candidate.rootPath),
                );
                const status = statuses[index];
                return {
                    id: repositoryId(repository.rootPath),
                    kind: repository.kind,
                    name: basename(repository.rootPath),
                    rootPath: repository.rootPath,
                    branch: status.branch,
                    head: status.head,
                    ahead: status.ahead,
                    behind: status.behind,
                    additions: status.additions,
                    deletions: status.deletions,
                    files: status.files.filter(
                        (file) =>
                            !children.some((child) =>
                                hidesChildRepository(file.path, child, repository.rootPath),
                            ),
                    ),
                };
            });
            return { isRepository: true, repositories };
        } catch (error) {
            /** A missing or unapproved repository is reported in the summary, never as a rejection. */
            return {
                isRepository: false,
                repositories: [],
                error: toGitError(error).message,
            };
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
