import { CaxriError, isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';

/**
 * Creates an empty Session for an Agent without moving the Workbench selection: the user keeps working where they are,
 * and the new Session appears in the sidebar under its Project. Only a Project the user added and can see qualifies; a
 * worktree Project never owns a Session of its own. The caller announces the change.
 *
 * A title names the Session manually: its Agent has not started, so there is no native session to rename, and automatic
 * naming would only replace the caller's subject with a name taken from the task-file pointer.
 */
export function createBackgroundSession(
    database: Pick<CaxriDatabase, 'createSession' | 'listVisibleProjects' | 'renameSession'>,
    projectId: string,
    title?: string,
): string {
    const project = database.listVisibleProjects().find((candidate) => candidate.id === projectId);
    if (!project || !isTopLevelProject(project))
        throw new CaxriError('NOT_FOUND', 'Project is unavailable for a new Session');
    const { session } = database.createSession(projectId, null, undefined, {
        selection: 'preserve',
    });
    if (title) database.renameSession(session.id, title);
    return session.id;
}

/**
 * Removes a Session created by {@link createBackgroundSession} that never received a Terminal, such as one created for a
 * delegation that was refused before it launched. Metadata only: a Session never owns user files. A Session that
 * meanwhile gained a Terminal is kept; `onDiscarded` announces an actual removal.
 */
export function discardEmptySession(
    database: Pick<CaxriDatabase, 'deleteSession' | 'listTerminals'>,
    sessionId: string,
    onDiscarded?: () => void,
): void {
    if (database.listTerminals(sessionId).length > 0) return;
    database.deleteSession(sessionId);
    onDiscarded?.();
}
