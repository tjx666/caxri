import { CaxriError, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { createBackgroundSession, discardEmptySession } from '../session';
import { commanderHandovers } from './handover-records';

/**
 * Upper bound on remembered Commander Sessions. Deleted Sessions drop out on every read, so this only caps a Commander
 * that keeps creating Sessions without the user ever deleting them.
 */
const MAX_COMMANDER_SESSIONS = 1_000;

/**
 * Creates an empty Session without moving the Workbench selection and records it as the Commander's. The Commander
 * Terminal must exist: the record is what later admits delegation into the Session. At capacity it refuses rather than
 * dropping the oldest record, which would silently disown a Session that may still run a task. The caller announces the
 * change.
 */
export function createCommanderSession(
    database: CaxriDatabase,
    projectId: string,
    logger?: StructuredLogger,
    title?: string,
): string {
    const rows = database.agentCommanderRows();
    if (!rows) throw new CaxriError('UNAVAILABLE', 'Agent Commander is not running');
    if (rows.sessionIds.length >= MAX_COMMANDER_SESSIONS)
        throw new CaxriError(
            'CAPACITY',
            `Agent Commander already owns ${MAX_COMMANDER_SESSIONS} Sessions; delete finished ones to create more`,
        );
    const sessionId = createBackgroundSession(database, projectId, title, rows.sessionId);
    database.setAppState('agentCommander', {
        projectId: rows.projectId,
        sessionId: rows.sessionId,
        ...(rows.terminalId && { terminalId: rows.terminalId }),
        sessionIds: [...rows.sessionIds, sessionId],
    });
    logger?.write('info', logEventCatalog.agentCommander.sessionCreated, {
        fields: { projectId, sessionId, ownedCount: rows.sessionIds.length + 1 },
    });
    return sessionId;
}

/**
 * Refuses a Session the Commander did not create, before `commander.session.archive` parks it. The Commander's own
 * hidden Session is not in that record either, so it can never archive itself. `NOT_FOUND` rather than `FORBIDDEN`,
 * matching how the Commander's other Session-scoped requests treat a Session outside its reach.
 *
 * The ownership record alone is not enough: a hand-over writes the same `sessionIds` list, and a Session the user
 * handed over is still the user's Session. The Commander may work in it, but archiving it would take the Session out of
 * the user's Workbench, so any Session with a hand-over record is refused too.
 */
export function requireCommanderSession(database: CaxriDatabase, sessionId: string): void {
    if (
        !database.agentCommanderRows()?.sessionIds.includes(sessionId) ||
        commanderHandovers(database).some((handover) => handover.sessionId === sessionId)
    )
        throw new CaxriError('NOT_FOUND', 'Session was not created by the Agent Commander');
}

/**
 * Removes a Commander Session that never received a Terminal, such as one created for a delegation that was refused
 * before it launched. Metadata only: a Session never owns user files. A Session that meanwhile gained a Terminal is
 * kept; `onDiscarded` announces an actual removal.
 */
export function discardCommanderSession(
    database: CaxriDatabase,
    sessionId: string,
    logger?: StructuredLogger,
    onDiscarded?: () => void,
): void {
    if (!database.agentCommanderRows()?.sessionIds.includes(sessionId)) return;
    discardEmptySession(database, sessionId, () => {
        logger?.write('info', logEventCatalog.agentCommander.sessionDiscarded, {
            fields: { sessionId },
        });
        onDiscarded?.();
    });
}
