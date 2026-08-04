import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { basename, dirname } from 'node:path';

import Database from 'better-sqlite3';

import { createTerminalLayout, removeTerminal } from '../shared/terminal-layout';
import type {
    AgentActivityState,
    AgentProvider,
    AgentSnapshot,
    ProcessState,
    ProjectRecord,
    SessionRecord,
    SessionState,
    TerminalKind,
    TerminalRecord,
    TerminalSnapshot,
} from '../shared/types';

interface ProjectRow {
    id: string;
    root_path: string;
    display_title: string;
    created_at: number;
    last_opened_at: number;
}

interface SessionRow {
    id: string;
    project_id: string;
    root_path: string;
    created_at: number;
    last_opened_at: number;
    default_agent_terminal_id: string | null;
    last_activity_state: AgentActivityState;
    layout_version: number;
    display_title: string;
}

interface TerminalRow {
    id: string;
    session_id: string;
    kind: TerminalKind;
    provider: 'claude' | 'codex' | null;
    cwd: string;
    title: string;
    icon: string;
    order_index: number;
    layout_node_id: string;
    agent_session_id: string | null;
    last_process_state: ProcessState;
    created_at: number;
    updated_at: number;
}

interface SnapshotRow {
    terminal_id: string;
    encoding_version: number;
    line_count: number;
    byte_count: number;
    payload: string;
    updated_at: number;
}

function processActivityState(state: ProcessState): AgentActivityState {
    if (state === 'running' || state === 'starting') return 'running';
    if (state === 'stopped') return 'completed';
    return 'failed';
}

const CURRENT_SCHEMA_VERSION = 3;
const MAX_TERMINALS_PER_SESSION = 16;
const MAX_TERMINALS_GLOBAL = 32;

function restrictPath(path: string, mode: number): void {
    try {
        chmodSync(path, mode);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
}

function mapSession(row: SessionRow): SessionRecord {
    return {
        id: row.id,
        projectId: row.project_id,
        rootPath: row.root_path,
        createdAt: row.created_at,
        lastOpenedAt: row.last_opened_at,
        defaultAgentTerminalId: row.default_agent_terminal_id ?? undefined,
        lastActivityState: row.last_activity_state,
        layoutVersion: row.layout_version,
        displayTitle: row.display_title,
    };
}

function mapProject(row: ProjectRow): ProjectRecord {
    return {
        id: row.id,
        rootPath: row.root_path,
        displayTitle: row.display_title,
        createdAt: row.created_at,
        lastOpenedAt: row.last_opened_at,
    };
}

const SESSION_SELECT = `
    SELECT sessions.id, sessions.project_id, projects.root_path,
           sessions.created_at, sessions.last_opened_at,
           sessions.default_agent_terminal_id, sessions.last_activity_state,
           sessions.layout_version, sessions.display_title
    FROM sessions
    JOIN projects ON projects.id = sessions.project_id`;

function mapTerminal(row: TerminalRow): TerminalRecord {
    return {
        id: row.id,
        sessionId: row.session_id,
        kind: row.kind,
        provider: row.provider ?? undefined,
        cwd: row.cwd,
        title: row.title,
        icon: row.icon,
        orderIndex: row.order_index,
        layoutNodeId: row.layout_node_id,
        agentSessionId: row.agent_session_id ?? undefined,
        lastProcessState: row.last_process_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

export class CaxriDatabase {
    readonly database: Database.Database;

    constructor(path: string) {
        if (path !== ':memory:') {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            /** Electron owns this userData directory, so restricting it also protects adjacent Caxri configuration and logs. */
            restrictPath(dirname(path), 0o700);
        }
        this.database = new Database(path);
        try {
            if (path !== ':memory:') restrictPath(path, 0o600);
            this.database.pragma('journal_mode = WAL');
            this.database.pragma('foreign_keys = ON');
            this.database.pragma('busy_timeout = 5000');
            this.initializeSchema();
            this.database
                .prepare(
                    "UPDATE terminals SET last_process_state = 'dead', updated_at = ? WHERE last_process_state IN ('running', 'starting')",
                )
                .run(Date.now());
            this.database
                .prepare(
                    "UPDATE sessions SET last_activity_state = 'failed' WHERE default_agent_terminal_id IN (SELECT id FROM terminals WHERE provider IS NOT NULL AND last_process_state = 'dead')",
                )
                .run();
            if (path !== ':memory:') {
                restrictPath(`${path}-wal`, 0o600);
                restrictPath(`${path}-shm`, 0o600);
            }
        } catch (error) {
            this.database.close();
            throw error;
        }
    }

    private initializeSchema(): void {
        const version = this.database.pragma('user_version', { simple: true }) as number;
        if (version > CURRENT_SCHEMA_VERSION) {
            throw new Error(
                `Database uses newer schema version ${version}; Caxri supports ${CURRENT_SCHEMA_VERSION}`,
            );
        }
        this.database.transaction(() => {
            if (version > 0 && version < CURRENT_SCHEMA_VERSION) {
                /** Pre-release metadata can be rebuilt; Project directories and user files are never touched. */
                this.database.exec(`
                    DROP TABLE IF EXISTS terminal_snapshots;
                    DROP TABLE IF EXISTS session_state;
                    DROP TABLE IF EXISTS terminals;
                    DROP TABLE IF EXISTS sessions;
                    DROP TABLE IF EXISTS projects;
                    DROP TABLE IF EXISTS app_state;
                `);
            }
            if (version < CURRENT_SCHEMA_VERSION) {
                this.database.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          root_path TEXT NOT NULL UNIQUE,
          display_title TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          last_opened_at INTEGER NOT NULL
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          last_opened_at INTEGER NOT NULL,
          default_agent_terminal_id TEXT,
          last_activity_state TEXT NOT NULL DEFAULT 'idle',
          layout_version INTEGER NOT NULL DEFAULT 2,
          display_title TEXT NOT NULL
        );

        CREATE TABLE terminals (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          kind TEXT NOT NULL,
          provider TEXT,
          cwd TEXT NOT NULL,
          title TEXT NOT NULL,
          icon TEXT NOT NULL,
          order_index INTEGER NOT NULL,
          layout_node_id TEXT NOT NULL,
          agent_session_id TEXT,
          last_process_state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE INDEX terminals_session_order ON terminals(session_id, order_index);
        CREATE INDEX sessions_project_activity ON sessions(project_id, last_opened_at DESC);

        CREATE TABLE terminal_snapshots (
          terminal_id TEXT PRIMARY KEY REFERENCES terminals(id) ON DELETE CASCADE,
          encoding_version INTEGER NOT NULL,
          line_count INTEGER NOT NULL,
          byte_count INTEGER NOT NULL,
          payload TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );

        CREATE TABLE session_state (
          session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
          open_tabs_json TEXT NOT NULL,
          active_tab TEXT,
          inspector_mode TEXT NOT NULL,
          layout_json TEXT NOT NULL
        );

        CREATE TABLE app_state (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL
        );
      `);
            }
            this.database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
        })();
    }

    listProjects(): ProjectRecord[] {
        return (
            this.database
                .prepare('SELECT * FROM projects ORDER BY last_opened_at DESC, created_at ASC')
                .all() as ProjectRow[]
        ).map(mapProject);
    }

    getProject(id: string): ProjectRecord | undefined {
        const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
            ProjectRow | undefined;
        return row ? mapProject(row) : undefined;
    }

    createProject(rootPath: string): ProjectRecord {
        const existing = this.database
            .prepare('SELECT * FROM projects WHERE root_path = ?')
            .get(rootPath) as ProjectRow | undefined;
        if (existing) return mapProject(existing);
        const id = randomUUID();
        const now = Date.now();
        this.database
            .prepare(
                `INSERT INTO projects (id, root_path, display_title, created_at, last_opened_at)
                 VALUES (?, ?, ?, ?, ?)`,
            )
            .run(id, rootPath, basename(rootPath) || rootPath, now, now);
        return this.getProject(id)!;
    }

    deleteProject(projectId: string): void {
        const result = this.database.prepare('DELETE FROM projects WHERE id = ?').run(projectId);
        if (result.changes !== 1) throw new Error('Project not found');
        if (this.getAppState<string>('lastSelectedProjectId') === projectId) {
            const fallbackProject = this.listProjects().at(0);
            const fallbackSession = fallbackProject
                ? this.listSessions(fallbackProject.id).at(0)
                : undefined;
            this.setAppState('lastSelectedProjectId', fallbackProject?.id ?? null);
            this.setAppState('lastSelectedSessionId', fallbackSession?.id ?? null);
        }
    }

    listSessions(projectId?: string): SessionRecord[] {
        return (
            projectId
                ? (this.database
                      .prepare(
                          `${SESSION_SELECT} WHERE sessions.project_id = ? ORDER BY sessions.last_opened_at DESC, sessions.created_at ASC`,
                      )
                      .all(projectId) as SessionRow[])
                : (this.database
                      .prepare(
                          `${SESSION_SELECT} ORDER BY sessions.last_opened_at DESC, sessions.created_at ASC`,
                      )
                      .all() as SessionRow[])
        ).map(mapSession);
    }

    getSession(id: string): SessionRecord | undefined {
        const row = this.database.prepare(`${SESSION_SELECT} WHERE sessions.id = ?`).get(id) as
            SessionRow | undefined;
        return row ? mapSession(row) : undefined;
    }

    updateAgentMetadata(
        sessionId: string,
        provider: AgentProvider,
        snapshot: AgentSnapshot,
    ): boolean {
        return this.database.transaction(() => {
            const session = this.getSession(sessionId);
            if (!session) return false;
            const candidates = this.listTerminals(sessionId)
                .filter((terminal) => terminal.provider === provider)
                .sort((left, right) => {
                    const leftActive = ['running', 'starting'].includes(left.lastProcessState);
                    const rightActive = ['running', 'starting'].includes(right.lastProcessState);
                    return (
                        Number(rightActive) - Number(leftActive) || right.updatedAt - left.updatedAt
                    );
                });
            const terminal =
                candidates.find(
                    (candidate) =>
                        snapshot.sessionId && candidate.agentSessionId === snapshot.sessionId,
                ) ?? candidates[0];
            if (!terminal) return false;
            const displayTitle = snapshot.title?.trim() || terminal.title;
            const agentSessionId = snapshot.sessionId?.trim() || undefined;
            const isDefaultAgent = terminal.id === session.defaultAgentTerminalId;
            if (
                (!isDefaultAgent ||
                    (session.displayTitle === displayTitle &&
                        session.lastActivityState === snapshot.status)) &&
                terminal.agentSessionId === agentSessionId
            )
                return false;
            if (isDefaultAgent)
                this.database
                    .prepare(
                        'UPDATE sessions SET display_title = ?, last_activity_state = ? WHERE id = ?',
                    )
                    .run(displayTitle, snapshot.status, sessionId);
            this.database
                .prepare('UPDATE terminals SET agent_session_id = ?, updated_at = ? WHERE id = ?')
                .run(agentSessionId ?? null, Date.now(), terminal.id);
            return true;
        })();
    }

    createSession(
        projectId: string,
        kind: TerminalKind,
    ): { session: SessionRecord; terminal: TerminalRecord } {
        return this.database.transaction(() => {
            this.assertTerminalCapacity();
            const project = this.getProject(projectId);
            if (!project) throw new Error('Project not found');
            const now = Date.now();
            const sessionId = randomUUID();
            const terminalId = randomUUID();
            const displayTitle =
                kind === 'shell' ? 'Shell' : kind === 'claude' ? 'Claude Code' : 'Codex';
            this.database
                .prepare(
                    `INSERT INTO sessions
           (id, project_id, created_at, last_opened_at, default_agent_terminal_id, last_activity_state, layout_version, display_title)
           VALUES (?, ?, ?, ?, ?, 'idle', 2, ?)`,
                )
                .run(sessionId, projectId, now, now, terminalId, displayTitle);
            this.database
                .prepare(
                    `INSERT INTO terminals
           (id, session_id, kind, provider, cwd, title, icon, order_index, layout_node_id, last_process_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, 'starting', ?, ?)`,
                )
                .run(
                    terminalId,
                    sessionId,
                    kind,
                    kind === 'shell' ? null : kind,
                    project.rootPath,
                    displayTitle,
                    kind,
                    randomUUID(),
                    now,
                    now,
                );
            this.database
                .prepare(
                    `INSERT INTO session_state (session_id, open_tabs_json, active_tab, inspector_mode, layout_json)
           VALUES (?, '[]', NULL, 'files', ?)`,
                )
                .run(sessionId, JSON.stringify(createTerminalLayout(terminalId)));
            this.setAppState('lastSelectedSessionId', sessionId);
            this.setAppState('lastSelectedProjectId', projectId);
            this.database
                .prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?')
                .run(now, projectId);
            return {
                session: this.getSession(sessionId)!,
                terminal: this.getTerminal(terminalId)!,
            };
        })();
    }

    selectSession(sessionId: string): void {
        const result = this.database
            .prepare('UPDATE sessions SET last_opened_at = ? WHERE id = ?')
            .run(Date.now(), sessionId);
        if (result.changes !== 1) throw new Error('Session not found');
        const session = this.getSession(sessionId)!;
        this.database
            .prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?')
            .run(Date.now(), session.projectId);
        this.setAppState('lastSelectedSessionId', sessionId);
        this.setAppState('lastSelectedProjectId', session.projectId);
    }

    deleteSession(sessionId: string): void {
        const result = this.database.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        if (result.changes !== 1) throw new Error('Session not found');
        if (this.getAppState<string>('lastSelectedSessionId') === sessionId) {
            const selectedProjectId = this.getAppState<string>('lastSelectedProjectId');
            const fallback = selectedProjectId
                ? this.listSessions(selectedProjectId).at(0)
                : this.listSessions().at(0);
            this.setAppState('lastSelectedSessionId', fallback?.id ?? null);
            this.setAppState(
                'lastSelectedProjectId',
                fallback?.projectId ?? selectedProjectId ?? null,
            );
        }
    }

    listTerminals(sessionId?: string): TerminalRecord[] {
        const rows = sessionId
            ? (this.database
                  .prepare('SELECT * FROM terminals WHERE session_id = ? ORDER BY order_index ASC')
                  .all(sessionId) as TerminalRow[])
            : (this.database
                  .prepare('SELECT * FROM terminals ORDER BY session_id, order_index ASC')
                  .all() as TerminalRow[]);
        return rows.map(mapTerminal);
    }

    getTerminal(id: string): TerminalRecord | undefined {
        const row = this.database.prepare('SELECT * FROM terminals WHERE id = ?').get(id) as
            TerminalRow | undefined;
        return row ? mapTerminal(row) : undefined;
    }

    createTerminal(sessionId: string, kind: TerminalKind): TerminalRecord {
        const session = this.getSession(sessionId);
        if (!session) throw new Error('Session not found');
        this.assertTerminalCapacity(sessionId);
        const id = randomUUID();
        const now = Date.now();
        const order = this.listTerminals(sessionId).length;
        this.database
            .prepare(
                `INSERT INTO terminals
         (id, session_id, kind, provider, cwd, title, icon, order_index, layout_node_id, last_process_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'starting', ?, ?)`,
            )
            .run(
                id,
                sessionId,
                kind,
                kind === 'shell' ? null : kind,
                session.rootPath,
                kind === 'shell' ? 'Shell' : kind === 'claude' ? 'Claude Code' : 'Codex',
                kind,
                order,
                randomUUID(),
                now,
                now,
            );
        return this.getTerminal(id)!;
    }

    private assertTerminalCapacity(sessionId?: string): void {
        if (this.listTerminals().length >= MAX_TERMINALS_GLOBAL)
            throw new Error(`Caxri supports at most ${MAX_TERMINALS_GLOBAL} Terminals`);
        if (sessionId && this.listTerminals(sessionId).length >= MAX_TERMINALS_PER_SESSION) {
            throw new Error(`A Session supports at most ${MAX_TERMINALS_PER_SESSION} Terminals`);
        }
    }

    updateTerminalState(id: string, state: ProcessState): void {
        this.database.transaction(() => {
            const terminal = this.getTerminal(id);
            if (!terminal) return;
            this.database
                .prepare('UPDATE terminals SET last_process_state = ?, updated_at = ? WHERE id = ?')
                .run(state, Date.now(), id);
            if (terminal.provider)
                this.database
                    .prepare(
                        'UPDATE sessions SET last_activity_state = ? WHERE default_agent_terminal_id = ?',
                    )
                    .run(processActivityState(state), id);
        })();
    }

    closeTerminal(id: string): void {
        this.database.transaction(() => {
            const terminal = this.getTerminal(id);
            if (!terminal) return;
            this.database
                .prepare(
                    "UPDATE sessions SET default_agent_terminal_id = NULL, last_activity_state = 'idle' WHERE default_agent_terminal_id = ?",
                )
                .run(id);
            this.database.prepare('DELETE FROM terminals WHERE id = ?').run(id);
            const state = this.getSessionState(terminal.sessionId);
            this.updateSessionState({ ...state, layout: removeTerminal(state.layout, id) });
        })();
    }

    getSnapshot(terminalId: string): TerminalSnapshot | undefined {
        const row = this.database
            .prepare('SELECT * FROM terminal_snapshots WHERE terminal_id = ?')
            .get(terminalId) as SnapshotRow | undefined;
        return row
            ? {
                  terminalId: row.terminal_id,
                  encodingVersion: row.encoding_version,
                  lineCount: row.line_count,
                  byteCount: row.byte_count,
                  payload: row.payload,
                  updatedAt: row.updated_at,
              }
            : undefined;
    }

    saveSnapshot(snapshot: TerminalSnapshot): void {
        this.database
            .prepare(
                `INSERT INTO terminal_snapshots
         (terminal_id, encoding_version, line_count, byte_count, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(terminal_id) DO UPDATE SET
           encoding_version = excluded.encoding_version,
           line_count = excluded.line_count,
           byte_count = excluded.byte_count,
           payload = excluded.payload,
           updated_at = excluded.updated_at`,
            )
            .run(
                snapshot.terminalId,
                snapshot.encodingVersion,
                snapshot.lineCount,
                snapshot.byteCount,
                snapshot.payload,
                snapshot.updatedAt,
            );
    }

    listSessionStates(): SessionState[] {
        return this.listSessions().map((session) => this.getSessionState(session.id));
    }

    getSessionState(sessionId: string): SessionState {
        const row = this.database
            .prepare('SELECT * FROM session_state WHERE session_id = ?')
            .get(sessionId) as
            | {
                  session_id: string;
                  open_tabs_json: string;
                  active_tab: string | null;
                  inspector_mode: SessionState['inspectorMode'];
                  layout_json: string;
              }
            | undefined;
        if (!row) {
            return {
                sessionId,
                openTabs: [],
                inspectorMode: 'files',
                layout: {},
            };
        }
        return {
            sessionId,
            openTabs: JSON.parse(row.open_tabs_json) as SessionState['openTabs'],
            activeTab: row.active_tab ?? undefined,
            inspectorMode: row.inspector_mode,
            layout: JSON.parse(row.layout_json) as SessionState['layout'],
        };
    }

    updateSessionState(state: SessionState): void {
        this.database
            .prepare(
                `INSERT INTO session_state (session_id, open_tabs_json, active_tab, inspector_mode, layout_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           open_tabs_json = excluded.open_tabs_json,
           active_tab = excluded.active_tab,
           inspector_mode = excluded.inspector_mode,
           layout_json = excluded.layout_json`,
            )
            .run(
                state.sessionId,
                JSON.stringify(state.openTabs),
                state.activeTab ?? null,
                state.inspectorMode,
                JSON.stringify(state.layout),
            );
    }

    getAppState<T>(key: string): T | undefined {
        const row = this.database
            .prepare('SELECT value_json FROM app_state WHERE key = ?')
            .get(key) as { value_json: string } | undefined;
        return row ? (JSON.parse(row.value_json) as T) : undefined;
    }

    setAppState(key: string, value: unknown): void {
        this.database
            .prepare(
                `INSERT INTO app_state (key, value_json) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
            )
            .run(key, JSON.stringify(value));
    }

    markAllStopped(): void {
        this.database.transaction(() => {
            this.database
                .prepare(
                    "UPDATE terminals SET last_process_state = 'stopped', updated_at = ? WHERE last_process_state IN ('running', 'starting')",
                )
                .run(Date.now());
            this.database
                .prepare(
                    "UPDATE sessions SET last_activity_state = 'completed' WHERE default_agent_terminal_id IN (SELECT id FROM terminals WHERE provider IS NOT NULL AND last_process_state = 'stopped')",
                )
                .run();
        })();
    }

    close(): void {
        this.database.close();
    }
}
