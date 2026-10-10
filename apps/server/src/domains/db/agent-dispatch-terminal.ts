import type { TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';
import type {
    NewAgentDispatchReceipt,
    StoredAgentDispatchReceipt,
} from './models/agent-dispatch-receipts';

/**
 * Binds a durable dispatch receipt to its new Terminal inside the caller's transaction, before any PTY can spawn.
 *
 * The archive check is repeated here, not only before the dispatch's async working-directory validation, because
 * `session.archive` parks just the Terminals that exist when it runs and automatic suspension skips archived Sessions:
 * an insert landing after an archive would launch an Agent nothing ever shows or stops. The check precedes both
 * inserts, so the outcome matches the early check: a `CONFLICT` with no receipt and no Terminal row.
 */
export function insertAgentDispatchWithTerminal(
    database: CaxriDatabaseConnection,
    input: NewAgentDispatchReceipt,
    insertTerminal: () => TerminalRecord,
): { stored: StoredAgentDispatchReceipt; terminal: TerminalRecord } {
    if (database.sessions.get(input.sessionId)?.archivedAt !== undefined)
        throw new CaxriError('CONFLICT', 'Restore the archived Session before dispatching');
    database.agentDispatchReceipts.insert(input);
    const terminal = insertTerminal();
    return {
        stored: database.agentDispatchReceipts.update(input.dispatchId, {
            status: 'starting',
            terminalId: terminal.id,
            now: input.now,
        }),
        terminal,
    };
}
