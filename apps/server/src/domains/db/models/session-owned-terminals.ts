import { asc, eq } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { terminals } from '../schema';

/**
 * Every durable Terminal of the Session, in creation order. This is what a Workbench Root that has never been arranged
 * shows in a single pane, and what a Session falls back to after an unreadable state row: no Terminal may be missing
 * from a Root's snapshot, or its PTY would keep running with nothing showing it.
 */
export function orderedTerminalIds(database: CaxriDrizzleDatabase, sessionId: string): string[] {
    return database
        .select({ id: terminals.id })
        .from(terminals)
        .where(eq(terminals.sessionId, sessionId))
        .orderBy(asc(terminals.orderIndex))
        .all()
        .map((terminal) => terminal.id);
}

/**
 * {@link orderedTerminalIds} for every Session at once, in one query.
 */
export function orderedTerminalIdsBySession(
    database: CaxriDrizzleDatabase,
): ReadonlyMap<string, readonly string[]> {
    const terminalIdsBySession = new Map<string, string[]>();
    const rows = database
        .select({ id: terminals.id, sessionId: terminals.sessionId })
        .from(terminals)
        .orderBy(asc(terminals.sessionId), asc(terminals.orderIndex))
        .all();
    for (const terminal of rows) {
        const terminalIds = terminalIdsBySession.get(terminal.sessionId);
        if (terminalIds) terminalIds.push(terminal.id);
        else terminalIdsBySession.set(terminal.sessionId, [terminal.id]);
    }
    return terminalIdsBySession;
}
