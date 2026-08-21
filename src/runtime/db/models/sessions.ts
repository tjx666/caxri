import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';

import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import { inspectorModeSchema } from '../../../shared/inspector';
import { sessionStateSchema } from '../../../shared/ipc/domain';
import { CaxriError } from '../../../shared/ipc/errors';
import { createPaneLayout, openResource, remapPaneLayoutPaths } from '../../../shared/pane-layout';
import type {
    AgentActivityState,
    SessionAttentionKind,
    SessionRecord,
    SessionState,
    SessionTitleMode,
} from '../../../shared/types';
import { isVirtualEditorTabPath } from '../../../shared/virtual-tabs';
import { isOutsideRoot } from '../../path-security';
import type { CaxriDrizzleDatabase } from '../connection';
import { DEFAULT_LAYOUT_VERSION } from '../connection';
import {
    CURRENT_SESSION_STATE_VERSION,
    projects,
    sessions,
    sessionState as sessionStateTable,
    terminals,
} from '../schema';

const workbenchProjects = alias(projects, 'workbench_projects');
const effectiveWorkbenchProjectId = sql<string>`COALESCE(${sessions.workbenchProjectId}, ${sessions.projectId})`;

const sessionSelection = {
    id: sessions.id,
    projectId: sessions.projectId,
    workbenchProjectId: effectiveWorkbenchProjectId,
    rootPath: workbenchProjects.rootPath,
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
    workbenchProjectId: string;
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
        workbenchProjectId: row.workbenchProjectId,
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

export interface SessionWorkbenchBinding {
    projectId: string;
    workbenchProjectId: string;
    rootDevice?: string;
    rootInode?: string;
}

interface SessionStateRow {
    sessionId: string;
    projectId: string;
    workbenchProjectId: string | null;
    stateVersion: number;
    workbenchStateJson: string;
    inspectorMode: string;
}

/**
 * One Workbench Root's durable snapshot. Terminal processes are Session-global; only their placement lives here, so
 * switching Root restores a different arrangement of the same Terminals without restarting anything.
 */
const workbenchEditorStateSchema = z.object({
    editorRemapOperationId: sessionStateSchema.shape.editorRemapOperationId,
    paneLayout: sessionStateSchema.shape.paneLayout,
});
const workbenchEditorStatesSchema = z
    .record(z.string().min(1).max(200), workbenchEditorStateSchema)
    .refine((states) => Object.keys(states).length <= 1_024, 'Too many Workbench Root states');
// `Partial` corrects `z.record`'s inferred type: real lookups by workbenchProjectId key can miss
// (Session-owned root has no state yet), but zod's inference promises every value is present.
type WorkbenchEditorStates = Partial<z.infer<typeof workbenchEditorStatesSchema>>;

function parseWorkbenchEditorStates(source: string): WorkbenchEditorStates | undefined {
    try {
        const parsed = workbenchEditorStatesSchema.safeParse(JSON.parse(source) as unknown);
        return parsed.success ? parsed.data : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Remaps one stored editor path after a Project root move. Note the parallel implementation for the `editorLayout`
 * tree: `remapEditorLayoutPaths` in `src/shared/editor-layout.ts` does a pure string-prefix rewrite (browser-safe, no
 * `node:path`), while this one uses `relative`/`resolve`. Both agree for Caxri's canonical absolute POSIX-style paths;
 * if either ever needs to handle non-canonical input, change both together.
 */
function remapStoredEditorPath(path: string, previousPath: string, nextPath: string): string {
    if (isVirtualEditorTabPath(path)) return path;
    const nested = relative(previousPath, path);
    if (nested === '') return nextPath;
    if (isOutsideRoot(nested)) return path;
    return resolve(nextPath, nested);
}

export interface SessionStateRepair {
    reason: 'invalid_json' | 'invalid_shape' | 'unsupported_version';
    sessionId: string;
    stateVersion: number;
}

/**
 * `inspector_mode` is a free-form text column whose accepted values narrow whenever a surface moves off the Inspector —
 * Info and Logs became Bottom Panel views, retiring those two ids. A row still holding a retired id would fail
 * `sessionStateSchema` and take the whole persisted Session down the `invalid_shape` repair path, discarding its open
 * tabs and split layout over one presentation field. Falling back to the default mode keeps the rest of the row intact;
 * the retired value carries nothing worth a full-state reset.
 */
function normalizeInspectorMode(value: string): string {
    return inspectorModeSchema.safeParse(value).success ? value : 'files';
}

/**
 * `fallbackPaneLayout` covers a Workbench Root the Session has never arranged: the row itself is healthy, so this is an
 * ordinary first visit rather than a repair.
 */
function parseSessionState(
    row: SessionStateRow,
    fallbackPaneLayout: () => SessionState['paneLayout'],
): { state: SessionState } | { reason: SessionStateRepair['reason'] } {
    if (row.stateVersion !== CURRENT_SESSION_STATE_VERSION)
        return { reason: 'unsupported_version' };
    let workbenchStatesSource: unknown;
    try {
        workbenchStatesSource = JSON.parse(row.workbenchStateJson) as unknown;
    } catch {
        return { reason: 'invalid_json' };
    }
    const workbenchStates = workbenchEditorStatesSchema.safeParse(workbenchStatesSource);
    if (!workbenchStates.success) return { reason: 'invalid_shape' };
    const workbenchProjectId = row.workbenchProjectId ?? row.projectId;
    // `z.record`'s inferred value type promises every key is present; cast through the `Partial`
    // alias so the lookup below is correctly typed as possibly missing.
    const states: WorkbenchEditorStates = workbenchStates.data;
    const rootState = states[workbenchProjectId];
    const candidate: unknown = {
        sessionId: row.sessionId,
        workbenchProjectId,
        editorRemapOperationId: rootState?.editorRemapOperationId,
        // See `normalizeInspectorMode`: a retired Inspector mode must not cost the Session its whole Workbench layout.
        inspectorMode: normalizeInspectorMode(row.inspectorMode),
        paneLayout: rootState?.paneLayout ?? fallbackPaneLayout(),
    };
    const parsed = sessionStateSchema.safeParse(candidate);
    return parsed.success ? { state: parsed.data } : { reason: 'invalid_shape' };
}

/**
 * Pure CRUD over `sessions` and its 1:1 `session_state` child row. Primary-Agent succession, default titles, and
 * deletion-fallback selection are decided in `../../session-policy.ts` and applied here through plain setters. Session
 * JSON is versioned and schema-validated at this boundary so a corrupt or future row can be repaired without failing
 * the full Runtime bootstrap.
 */
export class SessionsModel {
    constructor(
        private readonly database: CaxriDrizzleDatabase,
        private readonly onStateRepair?: (repair: SessionStateRepair) => void,
    ) {}

    /**
     * Places every durable Terminal of the Session into a single pane, in creation order. This is what a Workbench Root
     * that has never been arranged shows, and what a Session falls back to after an unreadable state row: no Terminal
     * may be missing from a Root's snapshot, or its PTY would keep running with nothing showing it.
     */
    private defaultPaneLayout(sessionId: string): SessionState['paneLayout'] {
        const sessionTerminals = this.database
            .select({ id: terminals.id })
            .from(terminals)
            .where(eq(terminals.sessionId, sessionId))
            .orderBy(asc(terminals.orderIndex), asc(terminals.id))
            .all();
        return sessionTerminals.reduce(
            (layout, terminal) =>
                openResource(layout, { kind: 'terminal', terminalId: terminal.id }),
            createPaneLayout(),
        );
    }

    private defaultState(sessionId: string): SessionState {
        const session = this.database
            .select({
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .get();
        return {
            sessionId,
            workbenchProjectId: session?.workbenchProjectId ?? session?.projectId ?? '',
            inspectorMode: 'files',
            paneLayout: this.defaultPaneLayout(sessionId),
        };
    }

    private readState(row: SessionStateRow): SessionState {
        const parsed = parseSessionState(row, () => this.defaultPaneLayout(row.sessionId));
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
            ? this.database
                  .select(sessionSelection)
                  .from(sessions)
                  .innerJoin(
                      workbenchProjects,
                      eq(workbenchProjects.id, effectiveWorkbenchProjectId),
                  )
                  .where(eq(sessions.projectId, projectId))
                  .orderBy(asc(sessions.createdAt), asc(sessions.id))
                  .all()
            : this.database
                  .select(sessionSelection)
                  .from(sessions)
                  .innerJoin(
                      workbenchProjects,
                      eq(workbenchProjects.id, effectiveWorkbenchProjectId),
                  )
                  .orderBy(asc(sessions.createdAt), asc(sessions.id))
                  .all();
        return rows.map(mapSession);
    }

    get(id: string): SessionRecord | undefined {
        const row = this.database
            .select(sessionSelection)
            .from(sessions)
            .innerJoin(workbenchProjects, eq(workbenchProjects.id, effectiveWorkbenchProjectId))
            .where(eq(sessions.id, id))
            .get();
        return row ? mapSession(row) : undefined;
    }

    getWorkbenchBinding(id: string): SessionWorkbenchBinding | undefined {
        const row = this.database
            .select({
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
                rootDevice: sessions.workbenchRootDevice,
                rootInode: sessions.workbenchRootInode,
            })
            .from(sessions)
            .where(eq(sessions.id, id))
            .get();
        if (!row) return undefined;
        return {
            projectId: row.projectId,
            workbenchProjectId: row.workbenchProjectId ?? row.projectId,
            rootDevice: row.rootDevice ?? undefined,
            rootInode: row.rootInode ?? undefined,
        };
    }

    /**
     * Persists an alternate authorized Project, or null-normalizes the owning Project.
     */
    setWorkbenchProject(
        sessionId: string,
        projectId: string,
        identity?: { device: string; inode: string },
    ): boolean {
        const owner = this.database
            .select({ projectId: sessions.projectId })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .get();
        if (!owner) return false;
        const isAlternate = projectId !== owner.projectId;
        return (
            this.database
                .update(sessions)
                .set({
                    workbenchProjectId: isAlternate ? projectId : null,
                    workbenchRootDevice: isAlternate ? (identity?.device ?? null) : null,
                    workbenchRootInode: isAlternate ? (identity?.inode ?? null) : null,
                })
                .where(eq(sessions.id, sessionId))
                .run().changes === 1
        );
    }

    listUsingWorkbenchProject(projectId: string): SessionRecord[] {
        const ids = this.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.workbenchProjectId, projectId))
            .all();
        return ids.flatMap(({ id }) => {
            const session = this.get(id);
            return session ? [session] : [];
        });
    }

    /**
     * Clears explicit bindings before an authorized Project row can be deleted.
     */
    resetWorkbenchProject(projectId: string): string[] {
        const sessionIds = this.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.workbenchProjectId, projectId))
            .all()
            .map(({ id }) => id);
        if (sessionIds.length > 0)
            this.database
                .update(sessions)
                .set({
                    workbenchProjectId: null,
                    workbenchRootDevice: null,
                    workbenchRootInode: null,
                })
                .where(eq(sessions.workbenchProjectId, projectId))
                .run();
        return sessionIds;
    }

    /**
     * A new Session never starts with a primary Agent Terminal; the caller assigns one afterward.
     */
    insert(input: NewSessionInput): SessionRecord {
        const id = randomUUID();
        const now = Date.now();
        this.database
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
        return this.database.delete(sessions).where(eq(sessions.id, id)).run().changes === 1;
    }

    /**
     * Returns true when a row existed and was touched.
     */
    touchLastOpened(id: string, now = Date.now()): boolean {
        /**
         * MRU switches can land inside one millisecond. A strictly increasing durable value keeps their ordering from
         * falling back to creation time or UUID order after the optimistic Renderer state settles.
         */
        const lastOpenedAt = sql<number>`MAX(${now}, COALESCE((SELECT MAX(${sessions.lastOpenedAt}) + 1 FROM ${sessions}), ${now}))`;
        return (
            this.database.update(sessions).set({ lastOpenedAt }).where(eq(sessions.id, id)).run()
                .changes === 1
        );
    }

    /**
     * Archiving is reversible metadata; it never removes or stops the Session's Terminals.
     */
    setArchived(id: string, archivedAt: number | null): boolean {
        return (
            this.database.update(sessions).set({ archivedAt }).where(eq(sessions.id, id)).run()
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
        this.database
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
        this.database
            .update(sessions)
            .set({
                displayTitle,
                lastActivityState,
                ...(attentionKind && {
                    attentionEpoch: sql`${sessions.attentionEpoch} + 1`,
                    lastAttentionKind: attentionKind,
                }),
            })
            .where(eq(sessions.id, id))
            .run();
    }

    /**
     * Acknowledges only the generation the Renderer actually displayed.
     */
    acknowledgeAttention(id: string, attentionEpoch: number): boolean {
        return (
            this.database
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
            this.database
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
        this.database
            .update(sessions)
            .set({ lastActivityState })
            .where(eq(sessions.primaryAgentTerminalId, terminalId))
            .run();
    }

    getState(sessionId: string): SessionState {
        const row = this.database
            .select({
                sessionId: sessionStateTable.sessionId,
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
                stateVersion: sessionStateTable.stateVersion,
                workbenchStateJson: sessionStateTable.workbenchStateJson,
                inspectorMode: sessionStateTable.inspectorMode,
            })
            .from(sessionStateTable)
            .innerJoin(sessions, eq(sessions.id, sessionStateTable.sessionId))
            .where(eq(sessionStateTable.sessionId, sessionId))
            .get();
        if (!row) return this.defaultState(sessionId);
        return this.readState(row);
    }

    /**
     * Loads every 1:1 Session state row in the same stable order as {@link list}.
     */
    listStates(): SessionState[] {
        const rows = this.database
            .select({
                sessionId: sessionStateTable.sessionId,
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
                stateVersion: sessionStateTable.stateVersion,
                workbenchStateJson: sessionStateTable.workbenchStateJson,
                inspectorMode: sessionStateTable.inspectorMode,
            })
            .from(sessionStateTable)
            .innerJoin(sessions, eq(sessions.id, sessionStateTable.sessionId))
            .orderBy(asc(sessions.createdAt), asc(sessions.id))
            .all();
        return rows.map((row) => this.readState(row));
    }

    insertInitialState(sessionId: string, terminalId?: string): void {
        const binding = this.getWorkbenchBinding(sessionId);
        const paneLayout = createPaneLayout(
            terminalId ? { kind: 'terminal', terminalId } : undefined,
        );
        this.database
            .insert(sessionStateTable)
            .values({
                sessionId,
                stateVersion: CURRENT_SESSION_STATE_VERSION,
                inspectorMode: 'files',
                workbenchStateJson: JSON.stringify(
                    binding ? { [binding.workbenchProjectId]: { paneLayout } } : {},
                ),
            })
            .run();
    }

    updateState(state: SessionState): void {
        const binding = this.getWorkbenchBinding(state.sessionId);
        if (!binding) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (binding.workbenchProjectId !== state.workbenchProjectId)
            throw new CaxriError('CONFLICT', 'Session state belongs to a stale Workbench Root');
        const existing = this.database
            .select({ workbenchStateJson: sessionStateTable.workbenchStateJson })
            .from(sessionStateTable)
            .where(eq(sessionStateTable.sessionId, state.sessionId))
            .get();
        // Only the selected Root's snapshot is rewritten; every other Root keeps the arrangement it was left in.
        const workbenchStates: WorkbenchEditorStates = {
            ...(existing && parseWorkbenchEditorStates(existing.workbenchStateJson)),
            [state.workbenchProjectId]: {
                paneLayout: state.paneLayout,
                ...(state.editorRemapOperationId && {
                    editorRemapOperationId: state.editorRemapOperationId,
                }),
            },
        };
        const values = {
            sessionId: state.sessionId,
            stateVersion: CURRENT_SESSION_STATE_VERSION,
            workbenchStateJson: JSON.stringify(workbenchStates),
            inspectorMode: state.inspectorMode,
        };
        this.database
            .insert(sessionStateTable)
            .values(values)
            .onConflictDoUpdate({
                target: sessionStateTable.sessionId,
                set: {
                    stateVersion: values.stateVersion,
                    workbenchStateJson: values.workbenchStateJson,
                    inspectorMode: values.inspectorMode,
                },
            })
            .run();
    }

    /**
     * Remaps one durable root snapshot even when its Session has since selected another root. Terminal occurrences
     * carry no path, so only document tabs move.
     */
    remapWorkbenchEditorState(
        workbenchProjectId: string,
        operationId: string,
        previousPath: string,
        nextPath: string,
    ): number {
        const rows = this.database
            .select({
                sessionId: sessionStateTable.sessionId,
                workbenchStateJson: sessionStateTable.workbenchStateJson,
            })
            .from(sessionStateTable)
            .all();
        let remappedCount = 0;
        for (const row of rows) {
            const workbenchStates = parseWorkbenchEditorStates(row.workbenchStateJson);
            const rootState = workbenchStates?.[workbenchProjectId];
            if (!workbenchStates || !rootState) continue;
            if (rootState.editorRemapOperationId === operationId) continue;
            const remappedState = {
                ...rootState,
                paneLayout: remapPaneLayoutPaths(rootState.paneLayout, (path) =>
                    remapStoredEditorPath(path, previousPath, nextPath),
                ),
                editorRemapOperationId: operationId,
            };
            this.database
                .update(sessionStateTable)
                .set({
                    workbenchStateJson: JSON.stringify({
                        ...workbenchStates,
                        [workbenchProjectId]: remappedState,
                    }),
                })
                .where(eq(sessionStateTable.sessionId, row.sessionId))
                .run();
            remappedCount += 1;
        }
        return remappedCount;
    }
}
