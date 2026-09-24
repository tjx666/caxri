import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

import {
    firstActiveSession,
    firstSelectableProject,
    selectFallbackAfterDeletion,
} from '../session-policy';
import type { CaxriDatabaseConnection } from './database-connection';

/**
 * Hides a top-level Project together with the worktree Projects registered on its behalf, keeping every row they own.
 * Returns the Sessions that left the Workbench so the caller can retire their runtime state. `ProjectsModel.create` is
 * what un-hides. Runs inside the caller's transaction.
 */
export function hideProject(
    database: CaxriDatabaseConnection,
    projectId: string,
    now: number,
): SessionRecord[] {
    const project = database.projects.get(projectId);
    if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
    if (!isTopLevelProject(project))
        throw new CaxriError('VALIDATION', 'Only a top-level Project can be hidden');
    const hiddenProjectIds = [
        projectId,
        ...database.projects.listOwnedBy(projectId).map((owned) => owned.id),
    ];
    for (const id of hiddenProjectIds) database.projects.setHidden(id, now);
    moveSelectionOffProjects(database, hiddenProjectIds);
    return hiddenProjectIds.flatMap((id) => database.sessions.list(id));
}

/**
 * Projects the Workbench presents. Authorization and root identity still read the full Project list, because a hidden
 * row keeps its root registered for the moment it is added back.
 */
export function listVisibleProjects(database: CaxriDatabaseConnection): ProjectRecord[] {
    return database.projects.list().filter((project) => project.hiddenAt === undefined);
}

/**
 * Sessions whose Project is not hidden. Anything that exists only to feed the Workbench — bootstrap, status polling,
 * pull-request lookup, CLI queries — reads this instead of the full Session list.
 */
export function listVisibleSessions(database: CaxriDatabaseConnection): SessionRecord[] {
    const hiddenProjectIds = new Set(
        database.projects
            .list()
            .filter((project) => project.hiddenAt !== undefined)
            .map((project) => project.id),
    );
    const sessions = database.sessions.list();
    return hiddenProjectIds.size === 0
        ? sessions
        : sessions.filter((session) => !hiddenProjectIds.has(session.projectId));
}

/**
 * Shared by deletion and hiding: when the selected Project is one of `projectIds`, selection falls back to the first
 * selectable Project that remains.
 *
 * Today the selection can only name the target Project itself: every writer of `lastSelectedProjectId` derives it from
 * a Session's own `projectId`, and `createSession` refuses owned Projects, so no Session ever lives in a worktree row.
 * The check still covers the whole cascaded set because comparing a handful of ids is free, while the failure it
 * prevents — the Renderer left pointing at a row that is gone — is one the caller cannot detect. Anything that later
 * makes an owned Project selectable is correct here by construction rather than by remembering to revisit this
 * fallback.
 */
export function moveSelectionOffProjects(
    database: CaxriDatabaseConnection,
    projectIds: readonly string[],
): void {
    const selectedProjectId = database.appState.get('lastSelectedProjectId');
    if (!selectedProjectId || !projectIds.includes(selectedProjectId)) return;
    const fallbackProject = firstSelectableProject(database.projects.list());
    const fallbackSession = fallbackProject
        ? firstActiveSession(database.sessions.list(fallbackProject.id))
        : undefined;
    const selection = selectFallbackAfterDeletion(fallbackSession, fallbackProject?.id ?? null);
    database.appState.set('lastSelectedProjectId', selection.projectId);
    database.appState.set('lastSelectedSessionId', selection.sessionId);
}
