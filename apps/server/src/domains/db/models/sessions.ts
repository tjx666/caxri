import { randomUUID } from 'node:crypto';
import { relative, resolve } from 'node:path';

import type {
    AgentActivityState,
    SessionAttentionKind,
    SessionRecord,
    SessionState,
    SessionTitleMode,
} from '@caxri/protocol';
import {
    addPaneTerminalSilently,
    CaxriError,
    createPaneLayout,
    isVirtualEditorTabPath,
    listPaneTerminalIds,
    openResource,
    remapPaneLayoutPaths,
    removePaneTerminal,
    sessionStateSchema,
} from '@caxri/protocol';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

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
    desiredSecondarySidebarViewContainerId: string;
}

/**
 * One Workbench Root's durable snapshot. Terminal processes are Session-global; only their placement lives here, so
 * switching Root restores a different arrangement of the same Terminals without restarting anything.
 */
const workbenchEditorStateSchema = z.object({
    editorRemapOperationId: sessionStateSchema.shape.editorRemapOperationId,
    extensionTreeViewStates: sessionStateSchema.shape.extensionTreeViewStates,
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

function pruneWorkbenchEditorState(source: string, projectId: string): string | undefined {
    try {
        const parsed = JSON.parse(source) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
        const candidate = { ...(parsed as Record<string, unknown>) };
        if (!Object.hasOwn(candidate, projectId)) return;
        delete candidate[projectId];
        if (!workbenchEditorStatesSchema.safeParse(candidate).success) return;
        return JSON.stringify(candidate);
    } catch {
        return;
    }
}

/**
 * Remaps one stored editor path after a Project root move. Note the parallel implementation for the `paneLayout` tree:
 * `remapPaneLayoutPaths` in `packages/protocol/src/domain/pane-layout-reducer.ts` does a pure string-prefix rewrite
 * (browser-safe, no `node:path`), while this one uses `relative`/`resolve`. Both agree for Caxri's canonical absolute
 * POSIX-style paths; if either ever needs to handle non-canonical input, change both together.
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
        // Availability is presentation state. Keep the desired ID even while its extension is absent or crashed.
        desiredSecondarySidebarViewContainerId: row.desiredSecondarySidebarViewContainerId,
        extensionTreeViewStates: rootState?.extensionTreeViewStates,
        paneLayout: rootState?.paneLayout ?? fallbackPaneLayout(),
    };
    const parsed = sessionStateSchema.safeParse(candidate);
    return parsed.success ? { state: parsed.data } : { reason: 'invalid_shape' };
}

/**
 * Pure CRUD over `sessions` and its 1:1 `session_state` child row. Primary-Agent succession, default titles, and
 * deletion-fallback selection are decided in `../../session-policy.ts` and applied here through plain setters. Session
 * JSON is versioned and schema-validated at this boundary so a corrupt or future row can be repaired without failing
 * the full domain-service composition root.
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
    private orderedTerminalIds(sessionId: string): string[] {
        return this.database
            .select({ id: terminals.id })
            .from(terminals)
            .where(eq(terminals.sessionId, sessionId))
            .orderBy(asc(terminals.orderIndex), asc(terminals.id))
            .all()
            .map((terminal) => terminal.id);
    }

    private orderedTerminalIdsBySession(): ReadonlyMap<string, readonly string[]> {
        const terminalIdsBySession = new Map<string, string[]>();
        const rows = this.database
            .select({ id: terminals.id, sessionId: terminals.sessionId })
            .from(terminals)
            .orderBy(asc(terminals.sessionId), asc(terminals.orderIndex), asc(terminals.id))
            .all();
        for (const terminal of rows) {
            const terminalIds = terminalIdsBySession.get(terminal.sessionId);
            if (terminalIds) terminalIds.push(terminal.id);
            else terminalIdsBySession.set(terminal.sessionId, [terminal.id]);
        }
        return terminalIdsBySession;
    }

    private defaultPaneLayout(terminalIds: readonly string[]): SessionState['paneLayout'] {
        return terminalIds.reduce(
            (layout, terminalId) => openResource(layout, { kind: 'terminal', terminalId }),
            createPaneLayout(),
        );
    }

    private defaultState(sessionId: string, terminalIds: readonly string[]): SessionState {
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
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: this.defaultPaneLayout(terminalIds),
        };
    }

    private readState(row: SessionStateRow, terminalIds?: readonly string[]): SessionState {
        const ownedTerminalIds = terminalIds ?? this.orderedTerminalIds(row.sessionId);
        const parsed = parseSessionState(row, () => this.defaultPaneLayout(ownedTerminalIds));
        if ('state' in parsed) {
            const paneLayout = this.pruneClosedTerminalTabs(
                parsed.state.paneLayout,
                ownedTerminalIds,
            );
            if (paneLayout === parsed.state.paneLayout) return parsed.state;
            const repaired = { ...parsed.state, paneLayout };
            this.updateState(repaired, ownedTerminalIds);
            return repaired;
        }
        const repaired = this.defaultState(row.sessionId, ownedTerminalIds);
        this.updateState(repaired, ownedTerminalIds);
        this.onStateRepair?.({
            sessionId: row.sessionId,
            stateVersion: row.stateVersion,
            reason: parsed.reason,
        });
        return repaired;
    }

    /**
     * Drops Terminal tabs the Session no longer owns. A client layout is a view preference, never authority over which
     * Terminals exist: a Renderer that closes a Terminal while an older layout write is still being assembled would
     * otherwise resurrect its tab here, leaving a permanently blank pane that no close can reach.
     */
    private pruneClosedTerminalTabs(
        paneLayout: SessionState['paneLayout'],
        terminalIds: readonly string[],
    ): SessionState['paneLayout'] {
        const owned = new Set(terminalIds);
        let pruned = paneLayout;
        for (const terminalId of listPaneTerminalIds(paneLayout))
            if (!owned.has(terminalId)) pruned = removePaneTerminal(pruned, terminalId);
        return pruned;
    }

    /**
     * Applies a Terminal placement change to every Root the Session has already arranged. Terminal ownership is
     * Session-global, not Root-scoped — see {@link defaultPaneLayout} — so a create or close must stay visible no matter
     * which Root the Session displays next, not just the one selected right now. A Root with no stored snapshot yet is
     * left alone: its first visit builds a layout straight from `terminals`, so it can never drift out of sync in the
     * first place.
     */
    private mutateTerminalAcrossRootStates(
        sessionId: string,
        mutate: (paneLayout: SessionState['paneLayout']) => SessionState['paneLayout'],
    ): void {
        const row = this.database
            .select({ workbenchStateJson: sessionStateTable.workbenchStateJson })
            .from(sessionStateTable)
            .where(eq(sessionStateTable.sessionId, sessionId))
            .get();
        if (!row) return;
        const states = parseWorkbenchEditorStates(row.workbenchStateJson);
        if (!states) return;
        let isChanged = false;
        const nextStates: WorkbenchEditorStates = {};
        for (const [workbenchProjectId, rootState] of Object.entries(states)) {
            if (!rootState) continue;
            const paneLayout = mutate(rootState.paneLayout);
            if (paneLayout !== rootState.paneLayout) isChanged = true;
            nextStates[workbenchProjectId] =
                paneLayout === rootState.paneLayout ? rootState : { ...rootState, paneLayout };
        }
        if (!isChanged) return;
        this.database
            .update(sessionStateTable)
            .set({ workbenchStateJson: JSON.stringify(nextStates) })
            .where(eq(sessionStateTable.sessionId, sessionId))
            .run();
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
        const stateRows = this.database
            .select({
                sessionId: sessionStateTable.sessionId,
                workbenchStateJson: sessionStateTable.workbenchStateJson,
            })
            .from(sessionStateTable)
            .all();
        for (const row of stateRows) {
            const pruned = pruneWorkbenchEditorState(row.workbenchStateJson, projectId);
            if (pruned !== undefined)
                this.database
                    .update(sessionStateTable)
                    .set({ workbenchStateJson: pruned })
                    .where(eq(sessionStateTable.sessionId, row.sessionId))
                    .run();
        }
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
                desiredSecondarySidebarViewContainerId:
                    sessionStateTable.desiredSecondarySidebarViewContainerId,
            })
            .from(sessionStateTable)
            .innerJoin(sessions, eq(sessions.id, sessionStateTable.sessionId))
            .where(eq(sessionStateTable.sessionId, sessionId))
            .get();
        if (!row) return this.defaultState(sessionId, this.orderedTerminalIds(sessionId));
        return this.readState(row);
    }

    /**
     * Loads every 1:1 Session state row in the same stable order as {@link list}.
     */
    listStates(terminalIdsBySession = this.orderedTerminalIdsBySession()): SessionState[] {
        const rows = this.database
            .select({
                sessionId: sessionStateTable.sessionId,
                projectId: sessions.projectId,
                workbenchProjectId: sessions.workbenchProjectId,
                stateVersion: sessionStateTable.stateVersion,
                workbenchStateJson: sessionStateTable.workbenchStateJson,
                desiredSecondarySidebarViewContainerId:
                    sessionStateTable.desiredSecondarySidebarViewContainerId,
            })
            .from(sessionStateTable)
            .innerJoin(sessions, eq(sessions.id, sessionStateTable.sessionId))
            .orderBy(asc(sessions.createdAt), asc(sessions.id))
            .all();
        return rows.map((row) =>
            this.readState(row, terminalIdsBySession.get(row.sessionId) ?? []),
        );
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
                desiredSecondarySidebarViewContainerId: 'caxri.files',
                workbenchStateJson: JSON.stringify(
                    binding ? { [binding.workbenchProjectId]: { paneLayout } } : {},
                ),
            })
            .run();
    }

    updateState(state: SessionState, terminalIds?: readonly string[]): void {
        const binding = this.getWorkbenchBinding(state.sessionId);
        if (!binding) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (binding.workbenchProjectId !== state.workbenchProjectId)
            throw new CaxriError('CONFLICT', 'Session state belongs to a stale Workbench Root');
        const existing = this.database
            .select({ workbenchStateJson: sessionStateTable.workbenchStateJson })
            .from(sessionStateTable)
            .where(eq(sessionStateTable.sessionId, state.sessionId))
            .get();
        const paneLayout = this.pruneClosedTerminalTabs(
            state.paneLayout,
            terminalIds ?? this.orderedTerminalIds(state.sessionId),
        );
        // Only the selected Root's snapshot is rewritten; every other Root keeps the arrangement it was left in.
        const workbenchStates: WorkbenchEditorStates = {
            ...(existing && parseWorkbenchEditorStates(existing.workbenchStateJson)),
            [state.workbenchProjectId]: {
                paneLayout,
                ...(state.extensionTreeViewStates && {
                    extensionTreeViewStates: state.extensionTreeViewStates,
                }),
                ...(state.editorRemapOperationId && {
                    editorRemapOperationId: state.editorRemapOperationId,
                }),
            },
        };
        const values = {
            sessionId: state.sessionId,
            stateVersion: CURRENT_SESSION_STATE_VERSION,
            workbenchStateJson: JSON.stringify(workbenchStates),
            desiredSecondarySidebarViewContainerId: state.desiredSecondarySidebarViewContainerId,
        };
        this.database
            .insert(sessionStateTable)
            .values(values)
            .onConflictDoUpdate({
                target: sessionStateTable.sessionId,
                set: {
                    stateVersion: values.stateVersion,
                    workbenchStateJson: values.workbenchStateJson,
                    desiredSecondarySidebarViewContainerId:
                        values.desiredSecondarySidebarViewContainerId,
                },
            })
            .run();
    }

    /**
     * Adds a newly created Terminal into every Root the Session has already arranged, so the next visit to any of them
     * shows it instead of only the Root that was active at creation time.
     */
    addTerminalToAllRootStates(sessionId: string, terminalId: string): void {
        this.mutateTerminalAcrossRootStates(sessionId, (paneLayout) =>
            addPaneTerminalSilently(paneLayout, terminalId),
        );
    }

    /**
     * Drops a closed or moved-away Terminal from every Root the Session has already arranged, so no stored snapshot
     * keeps a tab pointing at a PTY it no longer owns.
     */
    removeTerminalFromAllRootStates(sessionId: string, terminalId: string): void {
        this.mutateTerminalAcrossRootStates(sessionId, (paneLayout) =>
            removePaneTerminal(paneLayout, terminalId),
        );
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
