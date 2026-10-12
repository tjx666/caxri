import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';
import type { AppStateValue } from './models/app-state';

/**
 * The Agent Commander's own system rows, each confirmed to still exist.
 */
export interface AgentCommanderIdentity {
    projectId: string;
    sessionId: string;
    terminalId?: string;
}

export interface AgentCommanderRows extends AgentCommanderIdentity {
    /**
     * Sessions the Commander created in user Projects that still exist.
     */
    sessionIds: readonly string[];
}

/**
 * The point lookups that validate the Commander's system rows. Satisfied by `CaxriDatabase`'s own getters, so a caller
 * that holds only the repository facade can use `agentCommanderTerminal` without the raw connection.
 */
export interface AgentCommanderRowReader {
    getAppState(key: 'agentCommander'): AppStateValue<'agentCommander'> | undefined;
    getProject(id: string): Pick<ProjectRecord, 'id'> | undefined;
    getSession(id: string): Pick<SessionRecord, 'projectId'> | undefined;
    getTerminal(id: string): Pick<TerminalRecord, 'id' | 'sessionId'> | undefined;
}

/**
 * Validates the stored Project, Session, and Terminal IDs with a constant number of point lookups. The created-Session
 * list is deliberately left out: filtering it costs one lookup per stored ID (up to 1000).
 */
function validatedIdentity(
    stored: AppStateValue<'agentCommander'>,
    reader: Omit<AgentCommanderRowReader, 'getAppState'>,
): AgentCommanderIdentity | undefined {
    const session = reader.getSession(stored.sessionId);
    if (!reader.getProject(stored.projectId) || session?.projectId !== stored.projectId)
        return undefined;
    const terminal = stored.terminalId ? reader.getTerminal(stored.terminalId) : undefined;
    return {
        projectId: stored.projectId,
        sessionId: stored.sessionId,
        terminalId: terminal?.sessionId === stored.sessionId ? terminal.id : undefined,
    };
}

/**
 * Reads the Agent Commander's system rows from `app_state`, trusting only IDs whose rows still exist. The Commander
 * Project is a real Project row so its Terminal reuses the ordinary PTY and Agent Endpoint machinery; this record is
 * what keeps it out of every Workbench-facing list without a schema column.
 *
 * Costs one Session lookup per created Session. A per-event or per-keystroke caller that only needs to know which
 * Terminal is the Commander's uses `agentCommanderTerminal` instead.
 */
export function agentCommanderRows(
    database: CaxriDatabaseConnection,
): AgentCommanderRows | undefined {
    const stored = database.appState.get('agentCommander');
    if (!stored) return undefined;
    const identity = validatedIdentity(stored, {
        getProject: (id) => database.projects.get(id),
        getSession: (id) => database.sessions.get(id),
        getTerminal: (id) => database.terminals.get(id),
    });
    if (!identity) return undefined;
    return { ...identity, sessionIds: stored.sessionIds.filter((id) => database.sessions.get(id)) };
}

/**
 * The Commander's system rows, validated exactly as `agentCommanderRows` validates them but in constant time: the
 * created-Session list is never read. `terminalId` is absent while no Commander Terminal is recorded.
 */
export function agentCommanderIdentity(
    reader: AgentCommanderRowReader,
): AgentCommanderIdentity | undefined {
    const stored = reader.getAppState('agentCommander');
    return stored && validatedIdentity(stored, reader);
}

/**
 * The live Commander Terminal and its system Session, in constant time. Hot paths (every human keystroke in any
 * Terminal, every lifecycle signal, every delegation receipt) call this first so a non-Commander Terminal exits before
 * any per-Session work.
 */
export function agentCommanderTerminal(
    reader: AgentCommanderRowReader,
): Required<AgentCommanderIdentity> | undefined {
    const identity = agentCommanderIdentity(reader);
    return identity?.terminalId ? { ...identity, terminalId: identity.terminalId } : undefined;
}

/**
 * The Commander's system Project ID, which every Workbench-facing Project and Session list excludes. Unlike
 * `agentCommanderRows`, a stale Session reference does not matter here: the Project row alone decides exclusion.
 */
export function agentCommanderProjectId(database: CaxriDatabaseConnection): string | undefined {
    return database.appState.get('agentCommander')?.projectId;
}
