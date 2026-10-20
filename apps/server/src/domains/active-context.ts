import type { ServerOperationResult } from '@caxri/protocol';

import type { CaxriDatabase } from './db';

/**
 * Reports the Session the user is in right now: the focused window's, else the most recently focused window's (see
 * `WindowPresence.currentSessionId`). It counts only while its Project is visible, because a hidden Project's Sessions
 * never reach the Workbench.
 */
export function readActiveContext(
    database: Pick<CaxriDatabase, 'getSession' | 'listVisibleProjects'>,
    currentSessionId: () => string | undefined,
): ServerOperationResult<'app.activeContext'> {
    const projectIds = database.listVisibleProjects().map(({ id }) => id);
    const sessionId = currentSessionId();
    const session = sessionId ? database.getSession(sessionId) : undefined;
    if (!session || !projectIds.includes(session.projectId)) return { projectIds };
    return {
        ownerProjectId: session.projectId,
        projectIds,
        sessionId: session.id,
        workbenchProjectId: session.workbenchProjectId,
    };
}
