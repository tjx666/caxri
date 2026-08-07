import { randomUUID } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import { createTerminalLayout } from '../../../shared/terminal-layout';
import type { AgentActivityState, SessionRecord, SessionState } from '../../../shared/types';
import { projects, sessionState as sessionStateTable, sessions } from '../schema';
import { DEFAULT_LAYOUT_VERSION, type CaxriDrizzleDatabase } from '../connection';

const sessionSelection = {
    id: sessions.id,
    projectId: sessions.projectId,
    rootPath: projects.rootPath,
    createdAt: sessions.createdAt,
    lastOpenedAt: sessions.lastOpenedAt,
    archivedAt: sessions.archivedAt,
    primaryAgentTerminalId: sessions.primaryAgentTerminalId,
    lastActivityState: sessions.lastActivityState,
    layoutVersion: sessions.layoutVersion,
    displayTitle: sessions.displayTitle,
};

interface SessionJoinRow {
    id: string;
    projectId: string;
    rootPath: string;
    createdAt: number;
    lastOpenedAt: number;
    archivedAt: number | null;
    primaryAgentTerminalId: string | null;
    lastActivityState: string;
    layoutVersion: number;
    displayTitle: string;
}

function mapSession(row: SessionJoinRow): SessionRecord {
    return {
        id: row.id,
        projectId: row.projectId,
        rootPath: row.rootPath,
        createdAt: row.createdAt,
        lastOpenedAt: row.lastOpenedAt,
        archivedAt: row.archivedAt ?? undefined,
        primaryAgentTerminalId: row.primaryAgentTerminalId ?? undefined,
        lastActivityState: row.lastActivityState as AgentActivityState,
        layoutVersion: row.layoutVersion,
        displayTitle: row.displayTitle,
    };
}

export interface NewSessionInput {
    projectId: string;
    displayTitle: string;
}

interface SessionStateRow {
    sessionId: string;
    openTabsJson: string;
    activeTabJson: string | null;
    inspectorMode: string;
    layoutJson: string;
}

function mapSessionState(row: SessionStateRow): SessionState {
    return {
        sessionId: row.sessionId,
        openTabs: JSON.parse(row.openTabsJson) as SessionState['openTabs'],
        activeTab: row.activeTabJson
            ? (JSON.parse(row.activeTabJson) as SessionState['activeTab'])
            : undefined,
        inspectorMode: row.inspectorMode as SessionState['inspectorMode'],
        layout: JSON.parse(row.layoutJson) as SessionState['layout'],
    };
}

/**
 * Pure CRUD over `sessions` and its 1:1 `session_state` child row. Primary-Agent succession,
 * default titles, and deletion-fallback selection are decided in `../../session-policy.ts` and applied
 * here through plain setters; `session_state.active_tab_json` is opaque JSON serialized/deserialized
 * without ever being interpreted.
 */
export class SessionsModel {
    constructor(private readonly db: CaxriDrizzleDatabase) {}

    list(projectId?: string): SessionRecord[] {
        const rows = projectId
            ? this.db
                  .select(sessionSelection)
                  .from(sessions)
                  .innerJoin(projects, eq(projects.id, sessions.projectId))
                  .where(eq(sessions.projectId, projectId))
                  .orderBy(asc(sessions.createdAt), asc(sessions.id))
                  .all()
            : this.db
                  .select(sessionSelection)
                  .from(sessions)
                  .innerJoin(projects, eq(projects.id, sessions.projectId))
                  .orderBy(asc(sessions.createdAt), asc(sessions.id))
                  .all();
        return rows.map(mapSession);
    }

    get(id: string): SessionRecord | undefined {
        const row = this.db
            .select(sessionSelection)
            .from(sessions)
            .innerJoin(projects, eq(projects.id, sessions.projectId))
            .where(eq(sessions.id, id))
            .get();
        return row ? mapSession(row) : undefined;
    }

    /** A new Session never starts with a primary Agent Terminal; the caller assigns one afterward. */
    insert(input: NewSessionInput): SessionRecord {
        const id = randomUUID();
        const now = Date.now();
        this.db
            .insert(sessions)
            .values({
                id,
                projectId: input.projectId,
                createdAt: now,
                lastOpenedAt: now,
                primaryAgentTerminalId: null,
                lastActivityState: 'idle',
                layoutVersion: DEFAULT_LAYOUT_VERSION,
                displayTitle: input.displayTitle,
            })
            .run();
        return this.get(id)!;
    }

    remove(id: string): boolean {
        return this.db.delete(sessions).where(eq(sessions.id, id)).run().changes === 1;
    }

    /** Returns true when a row existed and was touched. */
    touchLastOpened(id: string, now = Date.now()): boolean {
        return (
            this.db.update(sessions).set({ lastOpenedAt: now }).where(eq(sessions.id, id)).run()
                .changes === 1
        );
    }

    /** Archiving is reversible metadata; it never removes or stops the Session's Terminals. */
    setArchived(id: string, archivedAt: number | null): boolean {
        return (
            this.db.update(sessions).set({ archivedAt }).where(eq(sessions.id, id)).run()
                .changes === 1
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
        this.db
            .update(sessions)
            .set({
                primaryAgentTerminalId: patch.primaryAgentTerminalId,
                displayTitle: patch.displayTitle,
                lastActivityState: patch.lastActivityState,
            })
            .where(eq(sessions.id, id))
            .run();
    }

    setDisplayTitleAndActivity(
        id: string,
        displayTitle: string,
        lastActivityState: AgentActivityState,
    ): void {
        this.db
            .update(sessions)
            .set({ displayTitle, lastActivityState })
            .where(eq(sessions.id, id))
            .run();
    }

    setActivityStateByPrimaryTerminal(
        terminalId: string,
        lastActivityState: AgentActivityState,
    ): void {
        this.db
            .update(sessions)
            .set({ lastActivityState })
            .where(eq(sessions.primaryAgentTerminalId, terminalId))
            .run();
    }

    getState(sessionId: string): SessionState {
        const row = this.db
            .select()
            .from(sessionStateTable)
            .where(eq(sessionStateTable.sessionId, sessionId))
            .get();
        if (!row) return { sessionId, openTabs: [], inspectorMode: 'files', layout: {} };
        return mapSessionState(row);
    }

    /** Loads every 1:1 Session state row in the same stable order as {@link list}. */
    listStates(): SessionState[] {
        const rows = this.db
            .select({
                sessionId: sessionStateTable.sessionId,
                openTabsJson: sessionStateTable.openTabsJson,
                activeTabJson: sessionStateTable.activeTabJson,
                inspectorMode: sessionStateTable.inspectorMode,
                layoutJson: sessionStateTable.layoutJson,
            })
            .from(sessionStateTable)
            .innerJoin(sessions, eq(sessions.id, sessionStateTable.sessionId))
            .orderBy(asc(sessions.createdAt), asc(sessions.id))
            .all();
        return rows.map(mapSessionState);
    }

    insertInitialState(sessionId: string, terminalId: string): void {
        this.db
            .insert(sessionStateTable)
            .values({
                sessionId,
                openTabsJson: '[]',
                activeTabJson: null,
                inspectorMode: 'files',
                layoutJson: JSON.stringify(createTerminalLayout(terminalId)),
            })
            .run();
    }

    updateState(state: SessionState): void {
        const values = {
            sessionId: state.sessionId,
            openTabsJson: JSON.stringify(state.openTabs),
            activeTabJson: state.activeTab === undefined ? null : JSON.stringify(state.activeTab),
            inspectorMode: state.inspectorMode,
            layoutJson: JSON.stringify(state.layout),
        };
        this.db
            .insert(sessionStateTable)
            .values(values)
            .onConflictDoUpdate({
                target: sessionStateTable.sessionId,
                set: {
                    openTabsJson: values.openTabsJson,
                    activeTabJson: values.activeTabJson,
                    inspectorMode: values.inspectorMode,
                    layoutJson: values.layoutJson,
                },
            })
            .run();
    }
}
