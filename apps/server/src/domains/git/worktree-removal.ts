import type { StructuredLogger } from '@caxri/system';

import type { GitCommandOptions } from './command';
import { runGitCommand } from './command';
import { serverGitCommands } from './command-budget';

type GitRunner = (
    cwd: string,
    arguments_: string[],
    options?: GitCommandOptions,
) => Promise<string>;

/**
 * Staging and committing a large dirty tree, and deleting a worktree that carries `node_modules` and build output, can
 * both outlast the 10s budget that bounds metadata commands.
 */
const WORKTREE_MUTATION_TIMEOUT_MS = 120_000;

export interface LinkedWorktreeRemovalInput {
    /**
     * Root of a surviving worktree of the same repository. `git worktree remove` runs there, because the removed
     * worktree is the current directory Git would otherwise be deleting out from under itself.
     */
    ownerRoot: string;
    rootPath: string;
    /**
     * Message of the commit that preserves non-ignored uncommitted changes on the worktree's branch.
     */
    backupMessage: string;
}

export type LinkedWorktreeRemoval =
    | { outcome: 'removed'; isBackupCommitted: boolean }
    | {
          outcome: 'refused';
          /**
           * `detached`: no branch holds HEAD, so commits made there and any backup commit would be reachable only
           * through the reflog. `operation-in-progress`: a merge, cherry-pick, or revert is half done, and a backup
           * commit would record its conflict state as if it were finished.
           */
          reason: 'detached' | 'operation-in-progress';
      };

/**
 * Pseudo-refs Git writes while a sequencer operation waits on the user. A rebase detaches HEAD, so `detached` already
 * covers it.
 */
const IN_PROGRESS_REFS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

/**
 * Deletes one linked worktree directory, including ignored files such as `node_modules`, after preserving every
 * non-ignored uncommitted change as a commit on its branch. The branch itself is kept, so the work stays reachable. The
 * backup skips commit hooks and signing: it is a local safety net, not a delivery commit, and a hook that fails or a
 * signing prompt nobody can answer would otherwise leave the worktree behind.
 */
export async function removeLinkedWorktree(
    git: GitRunner,
    input: LinkedWorktreeRemovalInput,
): Promise<LinkedWorktreeRemoval> {
    const { backupMessage, ownerRoot, rootPath } = input;
    const branch = await git(rootPath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        allowFailure: true,
    });
    if (branch.trim().length === 0) return { outcome: 'refused', reason: 'detached' };
    const inProgress = await Promise.all(
        IN_PROGRESS_REFS.map((reference) =>
            git(rootPath, ['rev-parse', '--quiet', '--verify', reference], { allowFailure: true }),
        ),
    );
    if (inProgress.some((head) => head.trim().length > 0))
        return { outcome: 'refused', reason: 'operation-in-progress' };
    const status = await git(rootPath, ['status', '--porcelain', '-z', '--untracked-files=all']);
    let isBackupCommitted = false;
    if (status.length > 0) {
        await git(rootPath, ['add', '--all'], { timeoutMs: WORKTREE_MUTATION_TIMEOUT_MS });
        await git(
            rootPath,
            ['-c', 'commit.gpgsign=false', 'commit', '--no-verify', '--quiet', '-m', backupMessage],
            { timeoutMs: WORKTREE_MUTATION_TIMEOUT_MS },
        );
        isBackupCommitted = true;
    }
    await git(ownerRoot, ['worktree', 'remove', '--force', '--', rootPath], {
        timeoutMs: WORKTREE_MUTATION_TIMEOUT_MS,
    });
    return { outcome: 'removed', isBackupCommitted };
}

/**
 * {@link removeLinkedWorktree} on the Server's shared Git command budget and structured `git.command` log.
 */
export function removeServerLinkedWorktree(
    logger: StructuredLogger,
    input: LinkedWorktreeRemovalInput,
): Promise<LinkedWorktreeRemoval> {
    return removeLinkedWorktree(
        (cwd, arguments_, options) =>
            runGitCommand(serverGitCommands, logger, cwd, arguments_, options),
        input,
    );
}
