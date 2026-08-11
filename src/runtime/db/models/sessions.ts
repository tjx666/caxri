import { randomUUID } from 'node:crypto';

import { and, asc, eq, lt, sql } from 'drizzle-orm';

import { sessionStateSchema } from '../../../shared/ipc/domain';
import { createTerminalLayout } from '../../../shared/terminal-layout';
import type {
    AgentActivityState,
    SessionAttentionKind,
    SessionRecord,
    SessionState,
    SessionTitleMode,
} from '../../../shared/types';
import {
    CURRENT_SESSION_STATE_VERSION,
    projects,
    sessionState as sessionStateTable,
    sessions,
    terminals,
} from '../schema';
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
    attentionEpoch: sessions.attentionEpoch,
    readAttentionEpoch: sessions.readAttentionEpoch,
    lastAttentionKind: sessions.lastAttentionKind,
    layoutVersion: sessions.layoutVersion,
    displayTitle: sessions.displayTitle,
    titleMode: sessions.titleMode,
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
    attentionEpoch: number;
    readAttentionEpoch: number;
    lastAttentionKind: string | null;
    layoutVersion: number;
    displayTitle: string;
    titleMode: string;
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
        attentionEpoch: row.attentionEpoch,
        readAttentionEpoch: row.readAttentionEpoch,
        lastAttentionKind: (row.lastAttentionKind as SessionAttentionKind | null) ?? undefined,
        hasUnread: row.attentionEpoch > row.readAttentionEpoch,
        layoutVersion: row.layoutVersion,
        displayTitle: row.displayTitle,
        titleMode: row.titleMode as SessionTitleMode,
    };
}

export interface NewSessionInput {
    projectId: string;
    displayTitle: string;
}

interface SessionStateRow {
    sessionId: string;
    stateVersion: number;
    openTabsJson: string;
    activeTabJson: string | null;
    inspectorMode: string;
    layoutJson: string;
}

export interface SessionStateRepair {
    reason: 'invalid_json' | 'invalid_shape' | 'unsupported_version';
    sessionId: string;
    stateVersion: number;
}

function parseSessionState(
    row: SessionStateRow,
): { state: SessionState } | { reason: SessionStateRepair['reason'] } {
    if (row.stateVersion !== CURRENT_SESSION_STATE_VERSION)
        return { reason: 'unsupported_version' };
    let candidate: unknown;
    try {
        candidate = {
            sessionId: row.sessionId,
            openTabs: JSON.parse(row.openTabsJson) as unknown,
            activeTab: row.activeTabJson ? (JSON.parse(row.activeTabJson) as unknown) : undefined,
            inspectorMode: row.inspectorMode,
            layout: JSON.parse(row.layoutJson) as unknown,
        };
    } catch {
        return { reason: 'invalid_json' };
    }
    const parsed = sessionStateSchema.safeParse(candidate);
    return parsed.success ? { state: parsed.data } : { reason: 'invalid_shape' };
}

/**
 * Pure CRUD over `sessions` and its 1:1 `session_state` child row. Primary-Agent succession,
 * default titles, and deletion-fallback selection are decided in `../../session-policy.ts` and applied
 * here through plain setters. Session JSON is versioned and schema-validated at this boundary so a
 * corrupt or future row can be repaired without failing the full Runtime bootstrap.
 */
export class SessionsModel {
    constructor(
        private readonly db: CaxriDrizzleDatabase,
        private readonly onStateRepair?: (repair: SessionStateRepair) => void,
    ) {}

    private defaultState(sessionId: string): SessionState {
        const firstTerminal = this.db
            .select({ id: terminals.id })
            .from(terminals)
            .where(eq(terminals.sessionId, sessionId))
            .orderBy(asc(terminals.orderIndex), asc(terminals.id))
            .get();
        return {
            sessionId,
            openTabs: [],
            inspectorMode: 'files',
            layout: firstTerminal ? createTerminalLayout(firstTerminal.id) : {},
        };
    }

    private readState(row: SessionStateRow): SessionState {
        const parsed = parseSessionState(row);
        if ('state' in parsed) return parsed.state;
        const repaired = this.defaultState(row.sessionId);
        this.updateState(repaired);
        this.onStateRepair?.({
            sessionId: row.sessionId,
            stateVersion: row.stateVersion,
            reason: parsed.reason,
        });
        return repaired;
    }

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
                attentionEpoch: 0,
                readAttentionEpoch: 0,
                lastAttentionKind: null,
                layoutVersion: DEFAULT_LAYOUT_VERSION,
                displayTitle: input.displayTitle,
                titleMode: 'automatic',
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
        attentionKind?: SessionAttentionKind,
    ): void {
        this.db
            .update(sessions)
            .set({
                displayTitle,
                lastActivityState,
                ...(attentionKind
                    ? {
                          attentionEpoch: sql`${sessions.attentionEpoch} + 1`,
                          lastAttentionKind: attentionKind,
                      }
                    : {}),
            })
            .where(eq(sessions.id, id))
            .run();
    }

    /** Acknowledges only the generation the Renderer actually displayed. */
    acknowledgeAttention(id: string, attentionEpoch: number): boolean {
        return (
            this.db
                .update(sessions)
                .set({ readAttentionEpoch: attentionEpoch })
                .where(
                    and(
                        eq(sessions.id, id),
                        eq(sessions.attentionEpoch, attentionEpoch),
                        lt(sessions.readAttentionEpoch, attentionEpoch),
                    ),
                )
                .run().changes === 1
        );
    }

    rename(id: string, displayTitle: string): boolean {
        return (
            this.db
                .update(sessions)
                .set({ displayTitle, titleMode: 'manual' })
                .where(eq(sessions.id, id))
                .run().changes === 1
        );
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
        if (!row) return this.defaultState(sessionId);
        return this.readState(row);
    }

    /** Loads every 1:1 Session state row in the same stable order as {@link list}. */
    listStates(): SessionState[] {
        const rows = this.db
            .select({
                sessionId: sessionStateTable.sessionId,
                stateVersion: sessionStateTable.stateVersion,
                openTabsJson: sessionStateTable.openTabsJson,
                activeTabJson: sessionStateTable.activeTabJson,
                inspectorMode: sessionStateTable.inspectorMode,
                layoutJson: sessionStateTable.layoutJson,
            })
            .from(sessionStateTable)
            .innerJoin(sessions, eq(sessions.id, sessionStateTable.sessionId))
            .orderBy(asc(sessions.createdAt), asc(sessions.id))
            .all();
        return rows.map((row) => this.readState(row));
    }

    insertInitialState(sessionId: string, terminalId: string): void {
        this.db
            .insert(sessionStateTable)
            .values({
                sessionId,
                stateVersion: CURRENT_SESSION_STATE_VERSION,
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
            stateVersion: CURRENT_SESSION_STATE_VERSION,
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
                    stateVersion: values.stateVersion,
                    activeTabJson: values.activeTabJson,
                    inspectorMode: values.inspectorMode,
                    layoutJson: values.layoutJson,
                },
            })
            .run();
    }
}
