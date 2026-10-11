import type { SessionRecord, TerminalRecord } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';
import {
    choosePrimaryAgentForNewTerminal,
    choosePrimaryAgentSuccessor,
    DEFAULT_SESSION_TITLE,
} from './session-policy';

/**
 * Moves a live Terminal (its PTY untouched) into a brand-new Session under the same Project, analogous to a browser
 * "move tab to new window". Mirrors `createSession`'s new-Session bootstrap and `closeTerminal`'s source-Session
 * cleanup, but in one transaction so the Terminal is never observably ownerless. The composition root must call
 * `TerminalManager.reassignSession` afterward to keep the live PTY cache's `sessionId` in sync: this DB call alone does
 * not touch the in-memory cache.
 */
export function moveTerminalToNewSession(
    database: CaxriDatabaseConnection,
    terminalId: string,
): { session: SessionRecord; terminal: TerminalRecord } {
    const terminal = database.terminals.get(terminalId);
    if (!terminal) throw new CaxriError('NOT_FOUND', 'Terminal not found');
    const sourceSession = database.sessions.get(terminal.sessionId);
    if (!sourceSession) throw new CaxriError('NOT_FOUND', 'Session not found');
    const project = database.projects.get(sourceSession.projectId);
    if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');

    const newSession = database.sessions.insert({
        projectId: sourceSession.projectId,
        displayTitle: DEFAULT_SESSION_TITLE,
    });

    database.terminals.reassignSession(terminalId, newSession.id);
    const movedTerminal = database.terminals.get(terminalId)!;

    // Source Session cleanup, mirroring `closeTerminal`.
    if (sourceSession.primaryAgentTerminalId === terminalId) {
        const remaining = database.terminals.list(sourceSession.id);
        const succession = choosePrimaryAgentSuccessor(remaining, sourceSession);
        database.sessions.setPrimaryAgent(sourceSession.id, succession);
    }
    database.sessions.removeTerminalFromAllRootStates(sourceSession.id, terminalId);

    // New Session state, mirroring `createSession`.
    const assignment = choosePrimaryAgentForNewTerminal(newSession, movedTerminal);
    if (assignment) database.sessions.setPrimaryAgent(newSession.id, assignment);
    database.sessions.insertInitialState(newSession.id, movedTerminal.id);

    database.appState.set('lastSelectedSessionId', newSession.id);
    database.appState.set('lastSelectedProjectId', project.id);
    database.projects.touchLastOpened(project.id);
    database.sessions.touchLastOpened(newSession.id);

    return {
        session: database.sessions.get(newSession.id)!,
        terminal: movedTerminal,
    };
}
