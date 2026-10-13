import type { SessionRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';
import { moveSelectionOffProjects } from './project-visibility';
import { clearDeletedSessionCreators } from './session-creator';

/**
 * Every Project id a deletion of `projectId` removes: the Project itself plus the worktree Projects registered on its
 * behalf.
 */
function deletedProjectIds(database: CaxriDatabaseConnection, projectId: string): string[] {
    return [projectId, ...database.projects.listOwnedBy(projectId).map((owned) => owned.id)];
}

export interface ProjectDeletionScope {
    owned: SessionRecord[];
    workbench: SessionRecord[];
}

/**
 * The Sessions a Project deletion will affect, resolved before the deletion so runtime, Git, and status caches can be
 * evicted for exactly those Sessions.
 *
 * `owned` lists the Sessions belonging to the Project or to a worktree Project registered on its behalf; every one of
 * them is deleted. `workbench` lists the Sessions bound to any of those roots as their Workbench Root. The two overlap:
 * a Session in the deleted Project that had adopted one of its worktrees appears in both and is deleted. Only a
 * `workbench` Session owned by a Project that survives keeps existing, with its Workbench Root reset to its own Project
 * root.
 */
export function projectDeletionScope(
    database: CaxriDatabaseConnection,
    projectId: string,
): ProjectDeletionScope {
    const projectIds = deletedProjectIds(database, projectId);
    return {
        owned: projectIds.flatMap((id) => database.sessions.list(id)),
        workbench: projectIds.flatMap((id) => database.sessions.listUsingWorkbenchProject(id)),
    };
}

/**
 * Metadata only: no Project folder or user file is ever touched. Worktree Projects auto-registered on this Project's
 * behalf are removed first, through the same per-Project routine, because the PrimarySidebar hides them and no other
 * path could ever delete them; their Sessions and Terminals cascade by foreign key exactly as the owner's own do. Runs
 * inside the caller's transaction.
 */
export function deleteProjectMetadata(database: CaxriDatabaseConnection, projectId: string): void {
    const cascadedProjectIds = deletedProjectIds(database, projectId);
    /**
     * Foreign keys cascade the owned worktree Projects and every Session they own, and null
     * `sessions.workbench_project_id`. The Workbench root identity columns and the per-root JSON state are beyond any
     * foreign key, so each deleted root is cleared from them first.
     */
    for (const cascadedProjectId of cascadedProjectIds)
        database.sessions.resetWorkbenchProject(cascadedProjectId);
    if (!database.projects.remove(projectId))
        throw new CaxriError('NOT_FOUND', 'Project not found');
    clearDeletedSessionCreators(database);
    moveSelectionOffProjects(database, cascadedProjectIds);
}
