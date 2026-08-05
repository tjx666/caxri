import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { createTerminalLayout } from '../../shared/terminal-layout';
import type { AgentActivityState, SessionRecord, SessionState } from '../../shared/types';
import { DEFAULT_LAYOUT_VERSION } from './sqlite';

interface SessionRow {
    id: string;
    project_id: string;
    root_path: string;
    created_at: number;
    last_opened_at: number;
    primary_agent_terminal_id: string | null;
    last_activity_state: AgentActivityState;
    layout_version: number;
    display_title: string;
}

function mapSession(row: SessionRow): SessionRecord {
    return {
        id: row.id,
        projectId: row.project_id,
        rootPath: row.root_path,
        createdAt: row.created_at,
        lastOpenedAt: row.last_opened_at,
        primaryAgentTerminalId: row.primary_agent_terminal_id ?? undefined,
        lastActivityState: row.last_activity_state,
        layoutVersion: row.layout_version,
        displayTitle: row.display_title,
    };
}

const SESSION_SELECT = `
    SELECT sessions.id, sessions.project_id, projects.root_path,
           sessions.created_at, sessions.last_opened_at,
           sessions.primary_agent_terminal_id, sessions.last_activity_state,
           sessions.layout_version, sessions.display_title
    FROM sessions
    JOIN projects ON projects.id = sessions.project_id`;

export interface NewSessionInput {
    projectId: string;
    displayTitle: string;
}

interface SessionStateRow {
    session_id: string;
    open_tabs_json: string;
    active_tab_json: string | null;
    inspector_mode: SessionState['inspectorMode'];
    layout_json: string;
}

function mapSessionState(row: SessionStateRow): SessionState {
    return {
        sessionId: row.session_id,
        openTabs: JSON.parse(row.open_tabs_json) as SessionState['openTabs'],
        activeTab: row.active_tab_json
            ? (JSON.parse(row.active_tab_json) as SessionState['activeTab'])
            : undefined,
        inspectorMode: row.inspector_mode,
        layout: JSON.parse(row.layout_json) as SessionState['layout'],
    };
}

/**
 * Pure CRUD over `sessions` and its 1:1 `session_state` child row. Primary-Agent succession,
 * default titles, and deletion-fallback selection are decided in `../../session-policy` and applied
 * here through plain setters; `session_state.active_tab_json` is opaque JSON serialized/deserialized
 * without ever being interpreted.
 */
export class SessionsStore {
    constructor(private readonly database: Database.Database) {}

    list(projectId?: string): SessionRecord[] {
        const rows = projectId
            ? (this.database
                  .prepare(
                      `${SESSION_SELECT} WHERE sessions.project_id = ? ORDER BY sessions.created_at ASC, sessions.id ASC`,
                  )
                  .all(projectId) as SessionRow[])
            : (this.database
                  .prepare(`${SESSION_SELECT} ORDER BY sessions.created_at ASC, sessions.id ASC`)
                  .all() as SessionRow[]);
        return rows.map(mapSession);
    }

    get(id: string): SessionRecord | undefined {
        const row = this.database.prepare(`${SESSION_SELECT} WHERE sessions.id = ?`).get(id) as
            SessionRow | undefined;
        return row ? mapSession(row) : undefined;
    }

    /** A new Session never starts with a primary Agent Terminal; the caller assigns one afterward. */
    insert(input: NewSessionInput): SessionRecord {
        const id = randomUUID();
        const now = Date.now();
        this.database
            .prepare(
                `INSERT INTO sessions
                 (id, project_id, created_at, last_opened_at, primary_agent_terminal_id,
                  last_activity_state, layout_version, display_title)
                 VALUES (?, ?, ?, ?, NULL, 'idle', ${DEFAULT_LAYOUT_VERSION}, ?)`,
            )
            .run(id, input.projectId, now, now, input.displayTitle);
        return this.get(id)!;
    }

    remove(id: string): boolean {
        return this.database.prepare('DELETE FROM sessions WHERE id = ?').run(id).changes === 1;
    }

    /** Returns true when a row existed and was touched. */
    touchLastOpened(id: string, now = Date.now()): boolean {
        return (
            this.database
                .prepare('UPDATE sessions SET last_opened_at = ? WHERE id = ?')
                .run(now, id).changes === 1
        );
    }

    setPrimaryAgent(
        id: string,
        patch: {
            primaryAgentTerminalId: string | null;
            displayTitle: string;
            lastActivityState: AgentActivityState;
        },
    ): void {
        this.database
            .prepare(
                `UPDATE sessions
                 SET primary_agent_terminal_id = ?, display_title = ?, last_activity_state = ?
                 WHERE id = ?`,
            )
            .run(patch.primaryAgentTerminalId, patch.displayTitle, patch.lastActivityState, id);
    }

    setDisplayTitleAndActivity(
        id: string,
        displayTitle: string,
        lastActivityState: AgentActivityState,
    ): void {
        this.database
            .prepare('UPDATE sessions SET display_title = ?, last_activity_state = ? WHERE id = ?')
            .run(displayTitle, lastActivityState, id);
    }

    setActivityStateByPrimaryTerminal(
        terminalId: string,
        lastActivityState: AgentActivityState,
    ): void {
        this.database
            .prepare(
                'UPDATE sessions SET last_activity_state = ? WHERE primary_agent_terminal_id = ?',
            )
            .run(lastActivityState, terminalId);
    }

    getState(sessionId: string): SessionState {
        const row = this.database
            .prepare('SELECT * FROM session_state WHERE session_id = ?')
            .get(sessionId) as SessionStateRow | undefined;
        if (!row) return { sessionId, openTabs: [], inspectorMode: 'files', layout: {} };
        return mapSessionState(row);
    }

    /** Loads every 1:1 Session state row in the same stable order as {@link list}. */
    listStates(): SessionState[] {
        const rows = this.database
            .prepare(
                `SELECT session_state.* FROM session_state
                 JOIN sessions ON sessions.id = session_state.session_id
                 ORDER BY sessions.created_at ASC, sessions.id ASC`,
            )
            .all() as SessionStateRow[];
        return rows.map(mapSessionState);
    }

    insertInitialState(sessionId: string, terminalId: string): void {
        this.database
            .prepare(
                `INSERT INTO session_state (session_id, open_tabs_json, active_tab_json, inspector_mode, layout_json)
                 VALUES (?, '[]', NULL, 'files', ?)`,
            )
            .run(sessionId, JSON.stringify(createTerminalLayout(terminalId)));
    }

    updateState(state: SessionState): void {
        this.database
            .prepare(
                `INSERT INTO session_state (session_id, open_tabs_json, active_tab_json, inspector_mode, layout_json)
                 VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(session_id) DO UPDATE SET
                   open_tabs_json = excluded.open_tabs_json,
                   active_tab_json = excluded.active_tab_json,
                   inspector_mode = excluded.inspector_mode,
                   layout_json = excluded.layout_json`,
            )
            .run(
                state.sessionId,
                JSON.stringify(state.openTabs),
                state.activeTab === undefined ? null : JSON.stringify(state.activeTab),
                state.inspectorMode,
                JSON.stringify(state.layout),
            );
    }
}
