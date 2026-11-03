import type { TerminalKind, TerminalRecord, TerminalSurface } from '@caxri/protocol';
import { CaxriError, initialAgentChatPermission } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';
import { choosePrimaryAgentForNewTerminal, defaultTerminalTitle } from './session-policy';
import { assertTerminalCapacity } from './terminal-capacity';

/**
 * Adds a durable Terminal to a Session: checks the Terminal limits, titles it, elects it the primary Agent when the
 * Session has none, and puts it in every Workbench Root's layout. Callers run it inside a transaction.
 */
export function insertSessionTerminal(
    database: CaxriDatabaseConnection,
    sessionId: string,
    kind: TerminalKind,
    cwd?: string,
    surface?: TerminalSurface,
): TerminalRecord {
    const session = database.sessions.get(sessionId);
    if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
    const ownerProject = database.projects.get(session.projectId);
    if (!ownerProject) throw new CaxriError('NOT_FOUND', 'Project not found');
    assertTerminalCapacity(database.terminals, sessionId);
    const terminal = database.terminals.insert({
        sessionId,
        kind,
        cwd: cwd ?? ownerProject.rootPath,
        surface,
        title: defaultTerminalTitle(kind),
        ...(surface === 'chat' &&
            kind !== 'shell' && {
                chatPermission: initialAgentChatPermission(kind, ownerProject.chatDefaults),
            }),
    });
    const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
    if (assignment) database.sessions.setPrimaryAgent(sessionId, assignment);
    database.sessions.addTerminalToAllRootStates(sessionId, terminal.id);
    return terminal;
}
