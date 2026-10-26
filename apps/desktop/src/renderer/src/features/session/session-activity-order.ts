import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { compareSessionSidebarOrder } from '@caxri/protocol';

/**
 * Produces the exact visible Session sequence: Project order remains explicit and stable, while only Sessions inside
 * each Project follow their durable sidebar positions. Activity promotes one row; dragging does not change recency.
 */
export function activeSessionsInSidebarOrder(
    projects: readonly ProjectRecord[],
    sessions: readonly SessionRecord[],
): SessionRecord[] {
    const activeByProject = new Map<string, SessionRecord[]>();
    for (const session of sessions) {
        if (session.archivedAt !== undefined) continue;
        const projectSessions = activeByProject.get(session.projectId);
        if (projectSessions) projectSessions.push(session);
        else activeByProject.set(session.projectId, [session]);
    }
    const ordered: SessionRecord[] = [];
    for (const project of projects)
        ordered.push(
            ...(activeByProject.get(project.id) ?? []).toSorted(compareSessionSidebarOrder),
        );
    return ordered;
}
