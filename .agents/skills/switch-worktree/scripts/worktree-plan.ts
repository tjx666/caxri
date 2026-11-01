import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { CommandError, runCapture } from './process';
import { isPathPresent, listWorktrees, repoContext, withRepoLock, worktreeDirectory } from './repo';
import { assertSemanticBranch } from './worktree';
import { assertBranchContainsBase, assertRemoteBranchAbsent, hasBranch } from './worktree-branch';

export interface PlanOptions {
    base?: string;
    branch: string;
    cwd: string;
}

/**
 * The `git worktree add` an Agent must run itself, as its own shell command, before `create` adopts the checkout.
 *
 * The script never runs it: Caxri attributes a new worktree to the Agent Session by classifying that literal command
 * (`apps/server/src/domains/agents/hooks/worktree-command.ts`), and a `git` process spawned from inside this script is
 * invisible to it, so the Session would stay on the primary checkout.
 */
export interface WorktreePlan {
    branch: string;
    /**
     * Argv to run, or `null` when Git already has the branch checked out and only `create` remains.
     */
    command: string[] | null;
    path: string;
}

async function didCommandSucceed(
    command: string,
    arguments_: string[],
    cwd: string,
): Promise<boolean> {
    try {
        await runCapture(command, arguments_, cwd);
        return true;
    } catch {
        return false;
    }
}

/**
 * Validates a branch and resolves the exact `git worktree add` for it, fetching `origin/main` for a new branch. See
 * {@link WorktreePlan} for why the caller, not this script, runs the command.
 */
export async function planWorktree(options: PlanOptions): Promise<WorktreePlan> {
    const context = await repoContext(options.cwd);
    return withRepoLock(context, async (): Promise<WorktreePlan> => {
        const worktrees = await listWorktrees(context);
        await assertBranchContainsBase(context.root, options.branch, options.base);
        const existing = worktrees.find((worktree) => worktree.branch === options.branch);
        if (existing) return { branch: options.branch, command: null, path: existing.path };
        if (
            !(await didCommandSucceed(
                'git',
                ['check-ref-format', '--branch', options.branch],
                context.root,
            ))
        ) {
            throw new CommandError(`Invalid branch name: ${options.branch}`, 2);
        }

        const path = worktreeDirectory(context, options.branch);
        await mkdir(resolve(path, '..'), { recursive: true });
        if (await isPathPresent(path)) {
            throw new CommandError(`Worktree path already exists: ${path}`);
        }
        if (await hasBranch(context.root, options.branch)) {
            return {
                branch: options.branch,
                command: ['git', 'worktree', 'add', path, options.branch],
                path,
            };
        }
        // An existing local branch keeps whatever name it already has; only a new one must be semantic.
        assertSemanticBranch(options.branch);
        await assertRemoteBranchAbsent(context.root, options.branch);
        const base = options.base ?? 'origin/main';
        if (!options.base)
            await runCapture('git', ['fetch', '--quiet', 'origin', 'main'], context.root);
        return {
            branch: options.branch,
            command: ['git', 'worktree', 'add', '-b', options.branch, path, base],
            path,
        };
    });
}
