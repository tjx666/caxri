import type { ProjectRecord } from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

/**
 * Moves one current Project so Renderer input stays scalar and cannot omit rows.
 *
 * `targetIndex` is a position among the Projects the PrimarySidebar actually renders, because that is the only order a
 * user can express. Auto-registered worktree Projects have no user-visible position, so they are excluded from the move
 * and re-appended after it; otherwise a hidden row sitting between two visible ones would silently shift every drop one
 * slot.
 */
export function reorderProject(
    database: CaxriDatabaseConnection,
    projectId: string,
    targetIndex: number,
): ProjectRecord[] {
    const current = database.projects.list();
    const visibleIds: string[] = [];
    const ownedIds: string[] = [];
    for (const project of current)
        (isTopLevelProject(project) ? visibleIds : ownedIds).push(project.id);
    if (
        !visibleIds.includes(projectId) ||
        !Number.isSafeInteger(targetIndex) ||
        targetIndex < 0 ||
        targetIndex >= visibleIds.length
    ) {
        throw new CaxriError(
            'VALIDATION',
            'Project reorder must reference a current Project and valid position',
        );
    }
    const reordered = visibleIds.filter((currentId) => currentId !== projectId);
    reordered.splice(targetIndex, 0, projectId);
    database.projects.reorder([...reordered, ...ownedIds]);
    return database.projects.list();
}
