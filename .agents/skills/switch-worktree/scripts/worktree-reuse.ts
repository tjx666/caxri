import { resolve } from 'node:path';

import { CommandError, runCapture } from './process';
import { listWorktrees, repoContext, withRepoLock } from './repo';
import type { ResolvedWorktree, WorktreeStatus } from './worktree';
import { assertSemanticBranch, finishManagedWorktree, resolveExistingTarget } from './worktree';
import { assertRemoteBranchAbsent, hasBranch } from './worktree-branch';
import { installWorktreeDependencies, prepareManagedWorktree } from './worktree-install';
import { assertWorktreeIdle, isWorktreeHeadMerged } from './worktree-safety';

export interface ReuseOptions {
    branch: string;
    cwd: string;
    install?: (path: string) => Promise<void>;
    target: string;
}

/**
 * Starts a new delivery on a fresh branch from `origin/main` inside an existing linked worktree whose last delivery has
 * merged. A raw `git switch -c` carries uncommitted files onto the new branch without complaint, so two parallel
 * sessions reusing the same checkout once moved one session's unfinished edits onto the other's branch. Every check
 * runs under the repository lock, so a concurrent `reuse` or `create` of the same target waits instead of racing.
 *
 * A clean checkout that another session has just switched to a fresh `origin/main` branch still passes: nothing on disk
 * records that claim yet.
 */
export async function reuseWorktree(options: ReuseOptions): Promise<WorktreeStatus> {
    assertSemanticBranch(options.branch);
    const context = await repoContext(options.cwd);
    const install = options.install ?? installWorktreeDependencies;
    const resolved = await withRepoLock(context, async (): Promise<ResolvedWorktree> => {
        const worktree = resolveExistingTarget(
            await listWorktrees(context),
            options.cwd,
            options.target,
        );
        if (!worktree) throw new CommandError(`No worktree matches: ${options.target}`, 2);
        if (resolve(worktree.path) === resolve(context.primaryRoot)) {
            throw new CommandError('Refusing to switch branches in the primary worktree', 2);
        }
        if (await hasBranch(context.root, options.branch)) {
            throw new CommandError(
                `Branch ${options.branch} already exists locally. Choose a new branch name.`,
                2,
            );
        }
        await assertRemoteBranchAbsent(context.root, options.branch);
        await assertWorktreeIdle(context, worktree, 'reuse');
        await runCapture('git', ['fetch', '--quiet', 'origin', 'main'], context.root);
        if (!(await isWorktreeHeadMerged(worktree.path))) {
            throw new CommandError(
                `Refusing to reuse worktree whose ${worktree.branch ?? 'HEAD'} is not merged into origin/main: ${worktree.path}`,
            );
        }
        await runCapture('git', ['switch', '-c', options.branch, 'origin/main'], worktree.path);
        return {
            identity: await prepareManagedWorktree(context, worktree.path),
            kind: 'install',
            path: worktree.path,
        };
    });
    return finishManagedWorktree(context, resolved, install);
}
