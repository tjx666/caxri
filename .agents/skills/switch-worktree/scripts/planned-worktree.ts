import { runCapture } from './process';
import type { CreateOptions, WorktreeStatus } from './worktree';
import { createWorktree } from './worktree';
import type { PlanOptions } from './worktree-plan';
import { planWorktree } from './worktree-plan';

/**
 * Test-only stand-in for the Agent's three steps: `plan`, the printed `git worktree add` as its own command, then
 * `create`. Production code never runs the planned command itself; see `WorktreePlan`.
 */
export async function addPlannedWorktree(
    options: CreateOptions & Pick<PlanOptions, 'base'>,
): Promise<WorktreeStatus> {
    const plan = await planWorktree({
        base: options.base,
        branch: options.branch,
        cwd: options.cwd,
    });
    if (plan.command) {
        const [program, ...arguments_] = plan.command;
        await runCapture(program, arguments_, options.cwd);
    }
    return createWorktree(options);
}
