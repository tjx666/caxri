import type { SessionRecord, TerminalKind, TerminalRecord } from '@caxri/protocol';
import { CaxriError, isTopLevelProject } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';
import { activateSessionInWindow } from './open-sessions';
import {
    choosePrimaryAgentForNewTerminal,
    DEFAULT_SESSION_TITLE,
    defaultTerminalTitle,
} from './session-policy';
import { assertTerminalCapacity } from './terminal-capacity';

export interface CreateSessionOptions {
    /**
     * Remote creation may preserve the Desktop's current selection.
     */
    selection?: 'select' | 'preserve';
    /**
     * The window that becomes active on the new Session when `selection` is not `preserve`. Without it only the global
     * "last Project" cell moves, which is how a Session created for no particular window stays out of every strip.
     */
    windowKey?: string;
    /**
     * The Session whose Agent asked for this one. Recorded once at creation and never inherited by a fork or move, so
     * only an Agent-created Session carries a creator.
     */
    createdBySessionId?: string;
}

/**
 * Creates a Session, with an optional first Terminal, inside the caller's transaction. Auto-registered worktree
 * Projects cannot own Sessions: their hidden rows offer no management UI; they can only be Workbench Roots of Sessions
 * in the owning Project.
 */
export function createSession(
    database: CaxriDatabaseConnection,
    projectId: string,
    kind: TerminalKind | null,
    cwd: string | undefined,
    options: CreateSessionOptions,
): { session: SessionRecord; terminal: TerminalRecord | null } {
    const project = database.projects.get(projectId);
    if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
    if (!isTopLevelProject(project))
        throw new CaxriError(
            'CONFLICT',
            'Sessions cannot be created inside an auto-registered worktree Project',
        );
    const session = database.sessions.insert({
        projectId,
        displayTitle: DEFAULT_SESSION_TITLE,
        ...(options.createdBySessionId && { createdBySessionId: options.createdBySessionId }),
    });
    let terminal: TerminalRecord | null = null;
    if (kind) {
        assertTerminalCapacity(database.terminals);
        terminal = database.terminals.insert({
            sessionId: session.id,
            kind,
            cwd: cwd ?? project.rootPath,
            title: defaultTerminalTitle(kind),
        });
        const assignment = choosePrimaryAgentForNewTerminal(session, terminal);
        if (assignment) database.sessions.setPrimaryAgent(session.id, assignment);
    }
    database.sessions.insertInitialState(session.id, terminal?.id);
    if (options.selection !== 'preserve') {
        database.appState.set('lastSelectedProjectId', projectId);
        if (options.windowKey) activateSessionInWindow(database, options.windowKey, session.id);
    }
    database.projects.touchLastOpened(projectId);
    return {
        session: database.sessions.get(session.id)!,
        terminal: terminal ? database.terminals.get(terminal.id)! : null,
    };
}
