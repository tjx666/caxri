import type { SessionRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

/**
 * `session.markRead`: acknowledges the attention generation the Client showed, leaving it pending.
 */
export function markAttentionRead(
    database: CaxriDatabaseConnection,
    sessionId: string,
    generation: number,
): { acknowledged: boolean; session: SessionRecord } {
    return database.transaction(() => {
        if (!database.sessions.get(sessionId))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        const isAcknowledged = database.sessions.acknowledgeAttention(sessionId, generation);
        return { acknowledged: isAcknowledged, session: database.sessions.get(sessionId)! };
    });
}

/**
 * `session.markDone`: resolves (and acknowledges) the attention generation the Client showed.
 */
export function markAttentionDone(
    database: CaxriDatabaseConnection,
    sessionId: string,
    generation: number,
    now: number,
): { resolved: boolean; session: SessionRecord } {
    return database.transaction(() => {
        if (!database.sessions.get(sessionId))
            throw new CaxriError('NOT_FOUND', 'Session not found');
        const isResolved = database.sessions.resolveAttention(sessionId, generation, now);
        return { resolved: isResolved, session: database.sessions.get(sessionId)! };
    });
}
