import type { CaxriDatabase } from '../db';

/**
 * The Agent left the worktree it had entered (Claude Code's `ExitWorktree`). When the Session is still rooted on
 * exactly that worktree, the follow is undone and the Session returns to its owning Project, so the status bar and file
 * tree do not keep showing a worktree the Agent is no longer in. A root the user chose by hand, or any other worktree,
 * is left alone, as is every Session under the `ignore` policy.
 *
 * Only a Chat takes part: it reports its directory solely from the explicit `ExitWorktree` tool. A Terminal Agent
 * reports its cwd on every hook, so a `cd` back to the root, or a removed worktree, keeps its existing handling (the
 * fallback notice) instead of a silent return.
 */
export function returnFromLeftWorktree(
    database: CaxriDatabase,
    behavior: string,
    {
        sessionId,
        surface,
        left,
    }: { sessionId: string; surface: 'chat' | undefined; left: string | undefined },
    select: (projectId: string) => void,
): void {
    const session = database.getSession(sessionId);
    if (surface !== 'chat' || !session || !left || behavior === 'ignore') return;
    if (session.workbenchRootProjectId === session.projectId) return;
    if (database.getProject(session.workbenchRootProjectId)?.rootPath !== left) return;
    select(session.projectId);
}
