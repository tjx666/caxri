import type { ProjectRecord, SessionRecord } from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

import { agentCommanderProjectId } from './commander-rows';
import type { CaxriDatabaseConnection } from './database-connection';
import {
    firstActiveSession,
    firstSelectableProject,
    selectFallbackAfterDeletion,
} from './session-policy';

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
 * True when adding `rootPath` again would un-hide a Project whose Sessions, including those of its owned worktree
 * Projects, still include an unarchived one. A hidden Project with nothing left to restore takes the first-add path.
 */
export function isRestorableProjectRoot(
    database: CaxriDatabaseConnection,
    rootPath: string,
): boolean {
    const project = database.projects.findByRootPath(rootPath);
    if (!project || !isTopLevelProject(project) || project.hiddenAt === undefined) return false;
    return [project, ...database.projects.listOwnedBy(project.id)].some(({ id }) =>
        database.sessions.list(id).some((session) => session.archivedAt === undefined),
    );
}

/**
 * Projects the Workbench presents. Authorization and root identity still read the full Project list, because a hidden
 * row keeps its root registered for the moment it is added back. The Agent Commander's system Project is never
 * presented: it exists only to host the Commander Terminal in its own window.
 */
export function listVisibleProjects(database: CaxriDatabaseConnection): ProjectRecord[] {
    const commanderProjectId = agentCommanderProjectId(database);
    return database.projects
        .list()
        .filter((project) => project.hiddenAt === undefined && project.id !== commanderProjectId);
}

/**
 * Sessions whose Project is not hidden. Anything that exists only to feed the Workbench (bootstrap, status polling,
 * pull-request lookup, CLI queries) reads this instead of the full Session list.
 */
export function listVisibleSessions(database: CaxriDatabaseConnection): SessionRecord[] {
    const excludedProjectIds = new Set(
        database.projects
            .list()
            .filter((project) => project.hiddenAt !== undefined)
            .map((project) => project.id),
    );
    const commanderProjectId = agentCommanderProjectId(database);
    if (commanderProjectId) excludedProjectIds.add(commanderProjectId);
    const sessions = database.sessions.list();
    return excludedProjectIds.size === 0
        ? sessions
        : sessions.filter((session) => !excludedProjectIds.has(session.projectId));
}

/**
 * Shared by deletion and hiding: when the selected Project is one of `projectIds`, selection falls back to the first
 * selectable Project that remains.
 *
 * Today the selection can only name the target Project itself: every writer of `lastSelectedProjectId` derives it from
 * a Session's own `projectId`, and `createSession` refuses owned Projects, so no Session ever lives in a worktree row.
 * The check still covers the whole cascaded set because comparing a handful of ids is free, while the failure it
 * prevents (the Renderer left pointing at a row that is gone) is one the caller cannot detect. Anything that later
 * makes an owned Project selectable is correct here by construction rather than by remembering to revisit this
 * fallback.
 */
export function moveSelectionOffProjects(
    database: CaxriDatabaseConnection,
    projectIds: readonly string[],
): void {
    const selectedProjectId = database.appState.get('lastSelectedProjectId');
    if (!selectedProjectId || !projectIds.includes(selectedProjectId)) return;
    const fallbackProject = firstSelectableProject(listVisibleProjects(database));
    const fallbackSession = fallbackProject
        ? firstActiveSession(database.sessions.list(fallbackProject.id))
        : undefined;
    const selection = selectFallbackAfterDeletion(fallbackSession, fallbackProject?.id ?? null);
    database.appState.set('lastSelectedProjectId', selection.projectId);
    database.appState.set('lastSelectedSessionId', selection.sessionId);
}
