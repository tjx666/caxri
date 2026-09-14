import { randomUUID } from 'node:crypto';

import type {
    AgentActivityState,
    SessionActivityReason,
    SessionAttentionKind,
    SessionRecord,
    SessionState,
} from '@caxri/protocol';
import {
    addPaneTerminalSilently,
    CaxriError,
    createPaneLayout,
    openResource,
    removePaneTerminal,
    sessionStateSchema,
} from '@caxri/protocol';
import { and, asc, eq, lt, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { DEFAULT_LAYOUT_VERSION } from '../connection';
import {
    CURRENT_SESSION_STATE_VERSION,
    sessions,
    sessionState as sessionStateTable,
    terminals,
} from '../schema';
import { didConsumeAttentionReply, didReleaseAttentionReply } from './attention-replies';
import { sessionActivityUpdate } from './session-activity';
import { didWriteAutomaticNaming, readAutomaticNaming } from './session-naming';
import {
    effectiveWorkbenchProjectId,
    mapSession,
    sessionSelection,
    workbenchProjects,
} from './session-record';
import { reconcileOwnedTerminalTabs, resolveSessionPaneLayout } from './session-terminal-layout';
import type { WorkbenchEditorStates } from './workbench-editor-state';
import {
    parseWorkbenchEditorStates,
    pruneWorkbenchEditorState,
    workbenchEditorStatesSchema,
} from './workbench-editor-state';

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
): { state: SessionState; isNewRoot: boolean } | { reason: SessionStateRepair['reason'] } {
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
        sourceControlViewStates: rootState?.sourceControlViewStates,
        paneLayout: rootState?.paneLayout ?? fallbackPaneLayout(),
    };
    const parsed = sessionStateSchema.safeParse(candidate);
    return parsed.success
        ? { state: parsed.data, isNewRoot: !rootState }
        : { reason: 'invalid_shape' };
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
            const paneLayout = reconcileOwnedTerminalTabs(
                parsed.state.paneLayout,
                ownedTerminalIds,
            );
            // Persist a first visit before another bootstrap can generate different pane/tab IDs.
            if (paneLayout === parsed.state.paneLayout && !parsed.isNewRoot) return parsed.state;
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
                ...sessionActivityUpdate('created', now),
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
     * The facade validates membership and owns the transaction for the complete move.
     */
    reorder(sessionIds: readonly string[]): void {
        for (const [sidebarOrder, id] of sessionIds.entries())
            this.database.update(sessions).set({ sidebarOrder }).where(eq(sessions.id, id)).run();
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
     * Advances only the product-owned Session Activity clock. Keeping the reason beside the timestamp makes every
     * caller choose an allowlisted, content-free event instead of inferring activity from arbitrary row writes.
     */
    touchActivity(id: string, reason: SessionActivityReason, now = Date.now()): boolean {
        return (
            this.database
                .update(sessions)
                .set(sessionActivityUpdate(reason, now))
                .where(eq(sessions.id, id))
                .run().changes === 1
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
        activityReason?: SessionActivityReason,
    ): void {
        const now = Date.now();
        this.database
            .update(sessions)
            .set({
                displayTitle,
                lastActivityState,
                ...(attentionKind && {
                    attentionEpoch: sql`${sessions.attentionEpoch} + 1`,
                    lastAttentionKind: attentionKind,
                }),
                ...(activityReason && sessionActivityUpdate(activityReason, now)),
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

    consumeAttentionReply(id: string, terminalId: string, attentionEpoch: number): boolean {
        return didConsumeAttentionReply(this.database, id, terminalId, attentionEpoch);
    }

    releaseAttentionReply(
        id: string,
        terminalId: string,
        attentionEpoch: number,
        activityAt: number,
    ): boolean {
        return didReleaseAttentionReply(this.database, id, terminalId, attentionEpoch, activityAt);
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

    automaticNaming(id: string) {
        return readAutomaticNaming(this.database, id);
    }

    setAutomaticNaming(
        id: string,
        value: NonNullable<typeof sessions.$inferSelect.automaticNaming>,
        displayTitle?: string,
    ): boolean {
        return didWriteAutomaticNaming(this.database, id, value, displayTitle);
    }

    setActivityStateByPrimaryTerminal(
        terminalId: string,
        lastActivityState: AgentActivityState,
        activityReason?: SessionActivityReason,
    ): boolean {
        const now = Date.now();
        return (
            this.database
                .update(sessions)
                .set({
                    lastActivityState,
                    ...(activityReason && sessionActivityUpdate(activityReason, now)),
                })
                .where(eq(sessions.primaryAgentTerminalId, terminalId))
                .run().changes === 1
        );
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
        const storedStates = existing
            ? parseWorkbenchEditorStates(existing.workbenchStateJson)
            : undefined;
        const paneLayout = resolveSessionPaneLayout(
            state.paneLayout,
            storedStates?.[state.workbenchProjectId]?.paneLayout,
            terminalIds ?? this.orderedTerminalIds(state.sessionId),
        );
        // Only the selected Root's snapshot is rewritten; every other Root keeps the arrangement it was left in.
        const workbenchStates: WorkbenchEditorStates = {
            ...storedStates,
            [state.workbenchProjectId]: {
                paneLayout,
                ...(state.extensionTreeViewStates && {
                    extensionTreeViewStates: state.extensionTreeViewStates,
                }),
                ...(state.sourceControlViewStates && {
                    sourceControlViewStates: state.sourceControlViewStates,
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
}
