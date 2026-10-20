import type { SessionRecord, SessionRestorePlacement } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';
import { reconcileWindowsAfterRemoval } from './project-visibility';
import { firstActiveSession } from './session-policy';

/**
 * Archives a Session without touching its Terminal records or PTYs. Every window that showed it moves to its neighbor
 * in the strip, else to another non-archived Session in the same Project, else to none (the Project stays selected).
 */
export function archiveOneSession(
    database: CaxriDatabaseConnection,
    sessionId: string,
    now: number,
): SessionRecord {
    return database.transaction(() => {
        const session = database.sessions.get(sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (session.archivedAt === undefined && !database.sessions.setArchived(sessionId, now))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        const fallback = firstActiveSession(database.sessions.list(session.projectId), sessionId);
        reconcileWindowsAfterRemoval(database, fallback, session.projectId);
        return database.sessions.get(sessionId)!;
    });
}

/**
 * Restores archived Sessions to active navigation without selecting or restarting them. `top` lifts the batch above
 * every other row in its Projects and keeps the caller's order, because a Session put back at the position it held
 * before archiving reappears wherever the user can no longer see it. `unchanged` serves the archive notice's Undo,
 * which reverses one archive and must leave an order the user built by dragging exactly as it found it.
 *
 * The whole batch shares one transaction, so a Session missing half-way through cannot leave the earlier rows restored
 * and the sidebar order partly rewritten.
 */
export function restoreArchivedSessions(
    database: CaxriDatabaseConnection,
    sessionIds: readonly string[],
    placement: SessionRestorePlacement,
): SessionRecord[] {
    return database.transaction(() => {
        for (const sessionId of sessionIds) {
            const session = database.sessions.get(sessionId);
            if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
            if (session.archivedAt !== undefined) database.sessions.setArchived(sessionId, null);
        }
        if (placement === 'top') database.sessions.moveToSidebarTop(sessionIds);
        return sessionIds.map((sessionId) => database.sessions.get(sessionId)!);
    });
}
