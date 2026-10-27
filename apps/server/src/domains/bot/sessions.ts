import { CaxriError, logEventCatalog } from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';

import type { CaxriDatabase } from '../db';
import { createBackgroundSession, discardEmptySession } from '../session';
import { botHandovers } from './handover-records';

/**
 * Upper bound on remembered Caxri Bot Sessions. Deleted Sessions drop out on every read, so this only caps a Caxri Bot
 * that keeps creating Sessions without the user ever deleting them.
 */
const MAX_BOT_SESSIONS = 1_000;

/**
 * Creates an empty Session without moving the Workbench selection and records it as Caxri Bot's. Caxri Bot Terminal
 * must exist: the record is what later admits delegation into the Session. At capacity it refuses rather than dropping
 * the oldest record, which would silently disown a Session that may still run a task. The caller announces the change.
 */
export function createBotSession(
    database: CaxriDatabase,
    projectId: string,
    logger?: StructuredLogger,
    title?: string,
): string {
    const rows = database.caxriBotRows();
    if (!rows) throw new CaxriError('UNAVAILABLE', 'Caxri Bot is not running');
    if (rows.sessionIds.length >= MAX_BOT_SESSIONS)
        throw new CaxriError(
            'CAPACITY',
            `Caxri Bot already owns ${MAX_BOT_SESSIONS} Sessions; delete finished ones to create more`,
        );
    const sessionId = createBackgroundSession(database, projectId, title, rows.sessionId);
    database.setAppState('caxriBot', {
        projectId: rows.projectId,
        sessionId: rows.sessionId,
        ...(rows.terminalId && { terminalId: rows.terminalId }),
        sessionIds: [...rows.sessionIds, sessionId],
    });
    logger?.write('info', logEventCatalog.caxriBot.sessionCreated, {
        fields: { projectId, sessionId, ownedCount: rows.sessionIds.length + 1 },
    });
    return sessionId;
}

/**
 * Refuses a Session Caxri Bot did not create, before `bot.session.archive` parks it. Caxri Bot's own hidden Session is
 * not in that record either, so it can never archive itself. `NOT_FOUND` rather than `FORBIDDEN`, matching how Caxri
 * Bot's other Session-scoped requests treat a Session outside its reach.
 *
 * The ownership record alone is not enough: a hand-over writes the same `sessionIds` list, and a Session the user
 * handed over is still the user's Session. Caxri Bot may work in it, but archiving it would take the Session out of the
 * user's Workbench, so any Session with a hand-over record is refused too.
 */
export function requireBotSession(database: CaxriDatabase, sessionId: string): void {
    if (
        !database.caxriBotRows()?.sessionIds.includes(sessionId) ||
        botHandovers(database).some((handover) => handover.sessionId === sessionId)
    )
        throw new CaxriError('NOT_FOUND', 'Session was not created by Caxri Bot');
}

/**
 * Removes a Caxri Bot Session that never received a Terminal, such as one created for a delegation that was refused
 * before it launched. Metadata only: a Session never owns user files. A Session that meanwhile gained a Terminal is
 * kept; `onDiscarded` announces an actual removal.
 */
export function discardBotSession(
    database: CaxriDatabase,
    sessionId: string,
    logger?: StructuredLogger,
    onDiscarded?: () => void,
): void {
    if (!database.caxriBotRows()?.sessionIds.includes(sessionId)) return;
    discardEmptySession(database, sessionId, () => {
        logger?.write('info', logEventCatalog.caxriBot.sessionDiscarded, {
            fields: { sessionId },
        });
        onDiscarded?.();
    });
}
