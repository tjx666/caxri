import type { CaxriDatabaseConnection } from './database-connection';
import { chooseLivePrimaryAgentSuccessor, choosePrimaryAgentSuccessor } from './session-policy';

type SuccessionStore = Pick<CaxriDatabaseConnection, 'sessions' | 'terminals'>;

/**
 * Hands a Session's primary Agent role to a live sibling when its Agent process exits but the Terminal stays. Returns
 * the Session ID when the role moved. Callers run it inside their own transaction.
 */
export function promoteLivePrimaryAgentSuccessor(
    database: SuccessionStore,
    exitedTerminalId: string,
): string | undefined {
    const terminal = database.terminals.get(exitedTerminalId);
    if (!terminal) return;
    const session = database.sessions.get(terminal.sessionId);
    if (!session) return;
    const succession = chooseLivePrimaryAgentSuccessor(
        database.terminals.list(terminal.sessionId),
        session,
        exitedTerminalId,
    );
    if (!succession) return;
    database.sessions.setPrimaryAgent(session.id, succession);
    return session.id;
}

/**
 * Removes a Terminal row and, when it was its Session's primary Agent, picks a successor. Callers run it inside their
 * own transaction.
 */
export function removeTerminalWithSuccession(database: SuccessionStore, id: string): void {
    const terminal = database.terminals.get(id);
    if (!terminal) return;
    /**
     * Read before removal: `primary_agent_terminal_id` is `ON DELETE SET NULL`, so afterwards the Session no longer
     * names the Terminal that needs a successor.
     */
    const session = database.sessions.get(terminal.sessionId);
    database.terminals.remove(id);
    if (session?.primaryAgentTerminalId === id) {
        const remaining = database.terminals.list(terminal.sessionId);
        database.sessions.setPrimaryAgent(
            terminal.sessionId,
            choosePrimaryAgentSuccessor(remaining, session),
        );
    }
    database.sessions.removeTerminalFromAllRootStates(terminal.sessionId, id, 'terminalClosed');
}
