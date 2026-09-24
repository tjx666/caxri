import type { ServerOperationResult } from '@caxri/protocol';

import type { CaxriDatabase } from './db';

/**
 * Mirrors what `app.bootstrap` reports as the selection: a selected Session counts only while its Project is visible,
 * because a hidden Project's Sessions never reach the Workbench.
 */
export function readActiveContext(
    database: Pick<CaxriDatabase, 'getAppState' | 'getSession' | 'listVisibleProjects'>,
): ServerOperationResult<'app.activeContext'> {
    const projectIds = database.listVisibleProjects().map(({ id }) => id);
    const selectedSessionId = database.getAppState('lastSelectedSessionId');
    const session = selectedSessionId ? database.getSession(selectedSessionId) : undefined;
    if (!session || !projectIds.includes(session.projectId)) return { projectIds };
    return {
        ownerProjectId: session.projectId,
        projectIds,
        sessionId: session.id,
        workbenchProjectId: session.workbenchProjectId,
    };
}
