import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

import { MAX_CONFIGURABLE_FILE_BYTES } from '../shared/ipc/domain';
import { CaxriError, isCaxriError } from '../shared/ipc/errors';
import type { StructuredLogger } from '../shared/node/logger';
import { safeProcessEnvironment } from '../shared/node/process-environment';
import type {
    GitDiffDocument,
    GitFileStatus,
    GitRepositorySummary,
    GitSummary,
} from '../shared/types';
import { assertInsideRoot, isOutsideRoot } from './path-security';
import { SingleFlight } from './single-flight';
import type { WorkspacePaths } from './workspace-paths';

const execFileAsync = promisify(execFile);

interface RepositoryStatus {
    branch: string;
    head?: string;
    ahead: number;
    behind: number;
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

export function describeGitFailure(error: unknown): string {
    const failure = error as NodeJS.ErrnoException & { killed?: boolean; stderr?: string };
    if (failure.code === 'ENOENT') return 'Git is not installed or is unavailable on PATH.';
    if (failure.killed || failure.message?.toLowerCase().includes('timed out'))
        return 'The Git operation timed out.';
    if (
        failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ||
        failure.message?.includes('maxBuffer')
    ) {
        return 'Git output exceeded the safety limit.';
    }
    if (failure.stderr?.toLowerCase().includes('not a git repository'))
        return 'The Project root is not a Git repository.';
    return 'The Git operation failed. See Runtime logs for details.';
}

/** Wraps a raw `execFile` fault as a `GIT` error while keeping the already user-facing wording. */
function toGitError(error: unknown): CaxriError {
    return isCaxriError(error) ? error : new CaxriError('GIT', describeGitFailure(error));
}

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

function parseStatus(output: string): RepositoryStatus {
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
    private readonly summaries = new SingleFlight<string, GitSummary>();

    constructor(
        private readonly paths: WorkspacePaths,
        private readonly logger: StructuredLogger,
    ) {}

    private async git(
        cwd: string,
        args: string[],
        options: { allowFailure?: boolean } = {},
    ): Promise<string> {
        const startedAt = performance.now();
        try {
            const { stdout } = await execFileAsync('git', args, {
                cwd,
                timeout: 10_000,
                maxBuffer: MAX_CONFIGURABLE_FILE_BYTES,
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
                    error: error instanceof Error ? error.message : 'unknown',
                },
            });
            throw toGitError(error);
        }
    }

    private loadStatus(rootPath: string): Promise<RepositoryStatus> {
        return this.git(rootPath, [
            'status',
            '--porcelain=v2',
            '--branch',
            '-z',
            '--untracked-files=all',
        ]).then(parseStatus);
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
        const nestedCandidates = await Promise.all(
            untrackedDirectoryOutput
                .split('\0')
                .filter((path) => path.endsWith('/'))
                .map(async (path) => {
                    const candidate = resolve(parent.rootPath, path);
                    try {
                        const marker = await lstat(resolve(candidate, '.git'));
                        if (marker.isSymbolicLink()) return undefined;
                        return candidate;
                    } catch {
                        return undefined;
                    }
                }),
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
        const discovered = await Promise.all(
            candidates.map(async (candidate): Promise<RepositoryRoot | undefined> => {
                const rootPath = await this.canonicalRepositoryRoot(candidate.path);
                if (!rootPath || !isApproved(rootPath, approvedRoots)) return undefined;
                return { kind: candidate.kind, rootPath };
            }),
        );
        return discovered.filter((value): value is RepositoryRoot => Boolean(value));
    }

    async summary(sessionId: string): Promise<GitSummary> {
        return this.summaries.run(sessionId, () => this.loadSummary(sessionId));
    }

    private async resolveDiffTarget(
        sessionId: string,
        repositoryIdValue: string,
        path: string,
    ): Promise<DiffTarget> {
        const summary = await this.summary(sessionId);
        const repository = summary.repositories.find(
            (candidate) => candidate.id === repositoryIdValue,
        );
        if (!repository)
            throw new CaxriError(
                'PATH_DENIED',
                'Git repository is outside the approved Project roots',
            );
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
                await this.git(repositoryRoot, [
                    'diff',
                    '--cached',
                    '--no-ext-diff',
                    '--no-color',
                    ...extraArguments,
                    '--',
                    relativePath,
                ]),
            );
        }
        if (![' ', '?'].includes(file.workingTree)) {
            chunks.push(
                await this.git(repositoryRoot, [
                    'diff',
                    '--no-ext-diff',
                    '--no-color',
                    ...extraArguments,
                    '--',
                    relativePath,
                ]),
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
