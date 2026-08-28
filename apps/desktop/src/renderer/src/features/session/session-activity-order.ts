import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { compareSessionActivityRecency } from '@caxri/protocol';

/**
 * Session Activity is a product-owned work clock, not visit history. The deterministic fallbacks matter for upgraded
 * rows and independently created records that can legitimately share one timestamp.
 */
export function sessionsByActivity(sessions: readonly SessionRecord[]): SessionRecord[] {
    return sessions.toSorted(compareSessionActivityRecency);
}

/**
 * Produces the exact visible Session sequence: Project order remains explicit and stable, while only Sessions inside
 * each Project move with meaningful activity.
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
        ordered.push(...sessionsByActivity(activeByProject.get(project.id) ?? []));
    return ordered;
}
