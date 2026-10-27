import type { ProjectRecord, SessionRecord, TerminalRecord } from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';
import type { AppStateValue } from './models/app-state';

/**
 * Caxri Bot's own system rows, each confirmed to still exist.
 */
export interface CaxriBotIdentity {
    projectId: string;
    sessionId: string;
    terminalId?: string;
}

export interface CaxriBotRows extends CaxriBotIdentity {
    /**
     * Sessions Caxri Bot created in user Projects that still exist.
     */
    sessionIds: readonly string[];
}

/**
 * The point lookups that validate Caxri Bot's system rows. Satisfied by `CaxriDatabase`'s own getters, so a caller that
 * holds only the repository facade can use `caxriBotTerminal` without the raw connection.
 */
export interface CaxriBotRowReader {
    getAppState(key: 'caxriBot'): AppStateValue<'caxriBot'> | undefined;
    getProject(id: string): Pick<ProjectRecord, 'id'> | undefined;
    getSession(id: string): Pick<SessionRecord, 'projectId'> | undefined;
    getTerminal(id: string): Pick<TerminalRecord, 'id' | 'sessionId'> | undefined;
}

/**
 * Validates the stored Project, Session, and Terminal IDs with a constant number of point lookups. The created-Session
 * list is deliberately left out: filtering it costs one lookup per stored ID (up to 1000).
 */
function validatedIdentity(
    stored: AppStateValue<'caxriBot'>,
    reader: Omit<CaxriBotRowReader, 'getAppState'>,
): CaxriBotIdentity | undefined {
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
 * Reads Caxri Bot's system rows from `app_state`, trusting only IDs whose rows still exist. Caxri Bot Project is a real
 * Project row so its Terminal reuses the ordinary PTY and Agent Endpoint machinery; this record is what keeps it out of
 * every Workbench-facing list without a schema column.
 *
 * Costs one Session lookup per created Session. A per-event or per-keystroke caller that only needs to know which
 * Terminal is Caxri Bot's uses `caxriBotTerminal` instead.
 */
export function caxriBotRows(database: CaxriDatabaseConnection): CaxriBotRows | undefined {
    const stored = database.appState.get('caxriBot');
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
 * Caxri Bot's system rows, validated exactly as `caxriBotRows` validates them but in constant time: the created-Session
 * list is never read. `terminalId` is absent while no Caxri Bot Terminal is recorded.
 */
export function caxriBotIdentity(reader: CaxriBotRowReader): CaxriBotIdentity | undefined {
    const stored = reader.getAppState('caxriBot');
    return stored && validatedIdentity(stored, reader);
}

/**
 * The live Caxri Bot Terminal and its system Session, in constant time. Hot paths (every human keystroke in any
 * Terminal, every lifecycle signal, every delegation receipt) call this first so a non-Caxri Bot Terminal exits before
 * any per-Session work.
 */
export function caxriBotTerminal(
    reader: CaxriBotRowReader,
): Required<CaxriBotIdentity> | undefined {
    const identity = caxriBotIdentity(reader);
    return identity?.terminalId ? { ...identity, terminalId: identity.terminalId } : undefined;
}

/**
 * Caxri Bot's system Project ID, which every Workbench-facing Project and Session list excludes. Unlike `caxriBotRows`,
 * a stale Session reference does not matter here: the Project row alone decides exclusion.
 */
export function caxriBotProjectId(database: CaxriDatabaseConnection): string | undefined {
    return database.appState.get('caxriBot')?.projectId;
}
