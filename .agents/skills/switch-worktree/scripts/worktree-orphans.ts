import type { WorktreeRecord } from './repo';
import { listWorktrees, repoContext } from './repo';
import type { ProcessEntry } from './worktree-processes';
import { findOrphanedProcesses, listProcesses } from './worktree-processes';

export interface OrphanProcess {
    command: string;
    pid: number;
    startedAt?: string;
}

export interface OrphanReport extends OrphanProcess {
    branch?: string;
    worktreePath: string;
}

export function toOrphanProcess({ command, pid, startedAt }: ProcessEntry): OrphanProcess {
    return {
        command,
        pid,
        ...(startedAt !== undefined &&
            Number.isFinite(startedAt) && { startedAt: new Date(startedAt).toISOString() }),
    };
}

export function describeOrphans(orphans: readonly OrphanProcess[]): string | undefined {
    if (orphans.length === 0) return undefined;
    const pids = orphans.map(({ pid }) => pid).join(', ');
    return `${orphans.length} orphaned process(es) run from this worktree without a live launcher (PIDs ${pids}); run stop in this worktree`;
}

export async function orphansByWorktree(
    worktrees: readonly WorktreeRecord[],
): Promise<Map<string, ProcessEntry[]>> {
    return findOrphanedProcesses(
        await listProcesses(),
        worktrees.map((worktree) => worktree.path),
    );
}

/**
 * Cheap repository-wide scan for the SessionStart hook: one `git worktree list` and one `ps`, no per-checkout Git
 * status. `minAgeMs` hides a run that only just lost its parent, such as a launcher restarting mid-command.
 */
export async function listOrphanedProcesses(
    cwd: string,
    { minAgeMs = 0, now = Date.now() }: { minAgeMs?: number; now?: number } = {},
): Promise<OrphanReport[]> {
    const worktrees = await listWorktrees(await repoContext(cwd));
    const orphans = await orphansByWorktree(worktrees);
    return worktrees.flatMap((worktree) =>
        (orphans.get(worktree.path) ?? [])
            .filter((entry) => entry.startedAt === undefined || now - entry.startedAt >= minAgeMs)
            .map((entry) => ({
                ...(worktree.branch && { branch: worktree.branch }),
                worktreePath: worktree.path,
                ...toOrphanProcess(entry),
            })),
    );
}
