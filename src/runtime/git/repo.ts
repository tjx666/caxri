import { createHash } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, relative, resolve, sep } from 'node:path';

import { CaxriError } from '../../shared/ipc/errors';
import { mapWithConcurrency } from '../../shared/node/concurrency';
import type {
    GitFileStatus,
    GitRepositorySummary as GitRepoSummary,
    GitSummary,
} from '../../shared/types';
import { isOutsideRoot } from '../path-security';
import type { ProjectRootResolver } from '../project-roots';
import { SingleFlight } from '../single-flight';
import { toGitError } from './errors';

const MAX_CONCURRENT_GIT_COMMANDS = 8;

interface RepoStatus {
    branch: string;
    head?: string;
    ahead: number;
    behind: number;
    additions: number;
    deletions: number;
    files: GitFileStatus[];
}

interface RepoRoot {
    kind: GitRepoSummary['kind'];
    rootPath: string;
}

export interface GitDirectoryRepo {
    directoryPath: string;
    ignoreRulePaths: readonly string[];
    rootPath: string;
}

interface GitRepoServiceOptions {
    git: (
        cwd: string,
        arguments_: string[],
        options?: { allowFailure?: boolean; maxBufferBytes?: number },
    ) => Promise<string>;
}

function statusKind(code: string): GitFileStatus['kind'] {
    if (code === 'AA' || code === 'DD' || code.includes('U')) return 'conflicted';
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

function parseStatus(output: string): Omit<RepoStatus, 'additions' | 'deletions'> {
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

function parseLineStats(output: string): Pick<RepoStatus, 'additions' | 'deletions'> {
    let additions = 0;
    let deletions = 0;
    for (const line of output.split('\n')) {
        const [added, deleted] = line.split('\t', 2);
        if (/^\d+$/.test(added)) additions += Number(added);
        if (/^\d+$/.test(deleted)) deletions += Number(deleted);
    }
    return { additions, deletions };
}

export interface GitWorktreeEntry {
    branch: string;
    rootPath: string;
}

/**
 * Shared parser for both Git Inspector discovery and Session Workbench Root attribution.
 */
export function parseWorktreeEntries(output: string): GitWorktreeEntry[] {
    return output.split('\0\0').flatMap((block) => {
        const fields = block.split('\0').filter(Boolean);
        const rootPath = fields
            .find((field) => field.startsWith('worktree '))
            ?.slice('worktree '.length);
        if (!rootPath) return [];
        const branchField = fields.find((field) => field.startsWith('branch '));
        const branch = branchField
            ? branchField.slice('branch '.length).replace(/^refs\/heads\//, '')
            : 'detached';
        return [{ branch, rootPath }];
    });
}

function parseWorktreeRoots(output: string): string[] {
    return parseWorktreeEntries(output).map((entry) => entry.rootPath);
}

function parseGitLinkPaths(output: string): string[] {
    return output
        .split('\0')
        .map((record) => /^160000 [0-9a-f]+ \d+\t(.+)$/.exec(record)?.[1])
        .filter((path): path is string => Boolean(path));
}

function repoId(rootPath: string): string {
    return createHash('sha256').update(rootPath).digest('hex').slice(0, 20);
}

function isPathContained(rootPath: string, candidate: string): boolean {
    return !isOutsideRoot(relative(rootPath, candidate));
}

function isApproved(rootPath: string, approvedRoots: string[]): boolean {
    return approvedRoots.some((approvedRoot) => isPathContained(approvedRoot, rootPath));
}

function isHiddenByChildRepo(
    filePath: string,
    child: Pick<RepoRoot, 'kind' | 'rootPath'>,
    parentRootPath: string,
): boolean {
    const childPath = relative(parentRootPath, child.rootPath);
    const normalizedChild = childPath.endsWith(sep) ? childPath.slice(0, -1) : childPath;
    const normalizedFile = filePath.endsWith(sep) ? filePath.slice(0, -1) : filePath;
    if (normalizedFile === normalizedChild && child.kind === 'submodule') return false;
    return (
        normalizedFile === normalizedChild || normalizedFile.startsWith(`${normalizedChild}${sep}`)
    );
}

/**
 * Owns Git repository discovery and containment for a Session: locating the primary repository and its
 * worktrees/submodules/nested repositories underneath an approved Project root, and building the aggregated
 * {@link GitSummary} that other Git operations resolve a repository from. Callers reach this exclusively through
 * {@link GitRepoService.summary} and {@link GitRepoService.resolveRepository}; all path containment enforcement lives
 * here so it is never duplicated by a sibling service.
 */
export class GitRepoService {
    private readonly summaries = new SingleFlight<string, GitSummary>();

    constructor(
        private readonly paths: ProjectRootResolver,
        private readonly options: GitRepoServiceOptions,
    ) {}

    private async loadStatus(rootPath: string): Promise<RepoStatus> {
        const [statusOutput, lineStatsOutput] = await Promise.all([
            this.options.git(rootPath, [
                'status',
                '--porcelain=v2',
                '--branch',
                '-z',
                '--untracked-files=all',
            ]),
            this.options.git(rootPath, ['diff', '--numstat', '--no-renames', 'HEAD', '--'], {
                allowFailure: true,
            }),
        ]);
        return { ...parseStatus(statusOutput), ...parseLineStats(lineStatsOutput) };
    }

    private async canonicalRepositoryRoot(path: string): Promise<string | undefined> {
        try {
            const canonical = await realpath(path);
            const topLevel = await realpath(
                (await this.options.git(canonical, ['rev-parse', '--show-toplevel'])).trim(),
            );
            return topLevel === canonical ? canonical : undefined;
        } catch {
            return undefined;
        }
    }

    private async discoverChildRepositories(
        parent: RepoRoot,
        approvedRoots: string[],
    ): Promise<RepoRoot[]> {
        const [gitLinkOutput, untrackedDirectoryOutput] = await Promise.all([
            this.options.git(parent.rootPath, ['ls-files', '--stage', '-z']),
            this.options.git(parent.rootPath, [
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
                    if (marker.isSymbolicLink()) return;
                    return candidate;
                } catch {
                    return;
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
            async (candidate): Promise<RepoRoot | undefined> => {
                const rootPath = await this.canonicalRepositoryRoot(candidate.path);
                if (!rootPath || !isApproved(rootPath, approvedRoots)) return undefined;
                return { kind: candidate.kind, rootPath };
            },
        );
        return discovered.filter((value): value is RepoRoot => Boolean(value));
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
                            return;
                        }
                    }),
                )
            ).filter((path): path is string => Boolean(path));
            const primaryRoot = await this.canonicalRepositoryRoot(projectRoot);
            if (!primaryRoot || !isApproved(primaryRoot, approvedRoots))
                throw Object.assign(new Error('not a git repository'), {
                    stderr: 'not a git repository within an approved Project root',
                });
            const worktreeOutput = await this.options.git(primaryRoot, [
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
            const baseRepositories: RepoRoot[] = [
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
                baseRepositories.map((repo) => this.loadStatus(repo.rootPath)),
            );
            const children = (
                await Promise.all(
                    baseRepositories.map((repo) =>
                        this.discoverChildRepositories(repo, approvedRoots),
                    ),
                )
            ).flat();
            const roots = [...baseRepositories, ...children].filter(
                (repo, index, repositories) =>
                    repositories.findIndex((candidate) => candidate.rootPath === repo.rootPath) ===
                    index,
            );
            const childStatuses = await Promise.all(
                roots.slice(baseRepositories.length).map((repo) => this.loadStatus(repo.rootPath)),
            );
            const statuses = [...baseStatuses, ...childStatuses];
            const repositories = roots.map((repo, index): GitRepoSummary => {
                const children = roots.filter(
                    (candidate) =>
                        candidate.rootPath !== repo.rootPath &&
                        isPathContained(repo.rootPath, candidate.rootPath),
                );
                const status = statuses[index];
                return {
                    id: repoId(repo.rootPath),
                    kind: repo.kind,
                    name: basename(repo.rootPath),
                    rootPath: repo.rootPath,
                    branch: status.branch,
                    head: status.head,
                    ahead: status.ahead,
                    behind: status.behind,
                    additions: status.additions,
                    deletions: status.deletions,
                    files: status.files.filter((file) =>
                        children.every(
                            (child) => !isHiddenByChildRepo(file.path, child, repo.rootPath),
                        ),
                    ),
                };
            });
            return { isRepository: true, repositories };
        } catch (error) {
            /**
             * A missing or unapproved repository is reported in the summary, never as a rejection.
             */
            return {
                isRepository: false,
                repositories: [],
                error: toGitError(error).message,
            };
        }
    }

    summary(sessionId: string): Promise<GitSummary> {
        return this.summaries.run(sessionId, () => this.loadSummary(sessionId));
    }

    async resolveRepository(sessionId: string, repoIdValue: string): Promise<GitRepoSummary> {
        const summary = await this.summary(sessionId);
        const repo = summary.repositories.find((candidate) => candidate.id === repoIdValue);
        if (!repo)
            throw new CaxriError(
                'PATH_DENIED',
                'Git repository is outside the approved Project roots',
            );
        return repo;
    }

    /**
     * Resolves the repository that owns one listed directory without crossing its Project root.
     */
    async resolveDirectory(
        sessionId: string,
        directory: string,
    ): Promise<GitDirectoryRepo | undefined> {
        const { root: projectRoot, path: directoryPath } = await this.paths.resolveSessionPath(
            sessionId,
            directory,
        );
        const output = await this.options.git(
            directoryPath,
            [
                'rev-parse',
                '--path-format=absolute',
                '--show-toplevel',
                '--git-path',
                'info/exclude',
                '--git-path',
                'config',
                '--git-path',
                'config.worktree',
            ],
            { allowFailure: true },
        );
        const [reportedRoot, ...ignoreRulePaths] = output.trim().split('\n');
        if (!reportedRoot) return undefined;
        try {
            const rootPath = await realpath(reportedRoot);
            /**
             * Project creation stores canonical roots; include the freshly resolved current root for migrated data.
             */
            const approvedRoots = [projectRoot, ...this.paths.listApprovedProjectRoots()];
            if (!isApproved(rootPath, approvedRoots)) return undefined;
            return {
                directoryPath,
                ignoreRulePaths: ignoreRulePaths.filter((path) => path.length > 0),
                rootPath,
            };
        } catch {
            return undefined;
        }
    }
}
