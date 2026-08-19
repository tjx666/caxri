import { CaxriError } from '../../shared/ipc/errors';
import type { RuntimeMethodParams as RuntimeMethodParameters } from '../../shared/ipc/methods';
import type { GitFileStatus, GitRepositorySummary as GitRepoSummary } from '../../shared/types';

/**
 * Network-bound Git operations (pull/push) can legitimately take far longer than local metadata commands; this bound
 * only guards against a wedged remote, not a slow one.
 */
const SYNC_TIMEOUT_MS = 120_000;

interface WorkingTreeCommandOptions {
    allowFailure?: boolean;
    timeoutMs?: number;
}

export interface GitWorkingTreeServiceOptions {
    git: (
        cwd: string,
        arguments_: string[],
        options?: WorkingTreeCommandOptions,
    ) => Promise<string>;
    resolveRepository: (sessionId: string, repoId: string) => Promise<GitRepoSummary>;
}

/**
 * Working-tree mutations behind the Git panel's Sync and Discard actions. Every discarded path is re-derived from the
 * Runtime's own status snapshot — the Renderer's `path` parameter is only a lookup key, so no Renderer-supplied string
 * ever reaches a Git argv.
 */
export class GitWorkingTreeService {
    constructor(private readonly options: GitWorkingTreeServiceOptions) {}

    private async discardAll(repo: GitRepoSummary): Promise<void> {
        if (repo.head) {
            await this.options.git(repo.rootPath, ['reset', '--hard']);
        } else {
            // A repository without commits has nothing to reset to; unstage everything so the
            // subsequent clean removes the files as untracked entries.
            await this.options.git(repo.rootPath, ['rm', '-r', '--cached', '--quiet', '--', '.'], {
                allowFailure: true,
            });
        }
        await this.options.git(repo.rootPath, ['clean', '-fd']);
    }

    private async discardFile(repo: GitRepoSummary, file: GitFileStatus): Promise<void> {
        switch (file.kind) {
            case 'untracked':
                await this.options.git(repo.rootPath, ['clean', '-fd', '--', file.path]);
                return;
            case 'added':
                await this.options.git(repo.rootPath, ['restore', '--staged', '--', file.path]);
                await this.options.git(repo.rootPath, ['clean', '-fd', '--', file.path]);
                return;
            case 'renamed': {
                if (!file.originalPath)
                    throw new CaxriError('GIT', 'Git reported a rename without its original path');
                // Restore the pre-rename file (index and working tree), then drop the renamed
                // copy, which the restore demoted to an untracked entry.
                await this.options.git(repo.rootPath, ['restore', '--staged', '--', file.path]);
                await this.options.git(repo.rootPath, [
                    'checkout',
                    'HEAD',
                    '--',
                    file.originalPath,
                ]);
                await this.options.git(repo.rootPath, ['clean', '-fd', '--', file.path]);
                return;
            }
            default:
                // `checkout <commit> -- <path>` restores both the index and the working tree, so
                // one command covers staged and unstaged modifications, deletions, and conflicts.
                await this.options.git(repo.rootPath, ['checkout', 'HEAD', '--', file.path]);
        }
    }

    /**
     * VS Code-style Sync Changes: integrate the upstream first, then publish local commits.
     */
    async sync(parameters: RuntimeMethodParameters<'git.sync'>): Promise<null> {
        const repo = await this.options.resolveRepository(
            parameters.sessionId,
            parameters.repositoryId,
        );
        await this.options.git(repo.rootPath, ['pull'], { timeoutMs: SYNC_TIMEOUT_MS });
        await this.options.git(repo.rootPath, ['push'], { timeoutMs: SYNC_TIMEOUT_MS });
        return null;
    }

    async discard(parameters: RuntimeMethodParameters<'git.discard'>): Promise<null> {
        const repo = await this.options.resolveRepository(
            parameters.sessionId,
            parameters.repositoryId,
        );
        if (parameters.scope.kind === 'all') {
            await this.discardAll(repo);
            return null;
        }
        const path = parameters.scope.path;
        const file = repo.files.find(
            (candidate) => candidate.path === path || candidate.originalPath === path,
        );
        // The change may have been committed or reverted since the snapshot the user acted on;
        // treat that as already discarded rather than failing the idempotent retry.
        if (!file) return null;
        await this.discardFile(repo, file);
        return null;
    }
}
