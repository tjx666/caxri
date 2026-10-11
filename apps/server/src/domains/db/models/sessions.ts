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
} from '@caxri/protocol';
import { and, asc, eq, lt, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import {
    CURRENT_SESSION_STATE_VERSION,
    sessions,
    sessionState as sessionStateTable,
    terminals,
} from '../schema';
import { didConsumeAttentionReply, didReleaseAttentionReply } from './attention-replies';
import { sessionActivityUpdate, sidebarTopOrder } from './session-activity';
import { didWriteAutomaticNaming, readAutomaticNaming } from './session-naming';
import {
    effectiveWorkbenchProjectId,
    mapSession,
    sessionSelection,
    workbenchProjects,
} from './session-record';
import type {
    SessionStateRepair,
    SessionStateRow,
    SessionStateUnchangedWrite,
} from './session-state-row';
import { parseSessionState } from './session-state-row';
import { reconcileOwnedTerminalTabs, resolveSessionPaneLayout } from './session-terminal-layout';
import type { WorkbenchEditorStates } from './workbench-editor-state';
import { parseWorkbenchEditorStates, pruneWorkbenchEditorState } from './workbench-editor-state';

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

/**
 * Pure CRUD over `sessions` and its 1:1 `session_state` child row. Primary-Agent succession, default titles, and
 * deletion-fallback selection are decided in `../session-policy.ts` and applied here through plain setters. Session
 * JSON is versioned and schema-validated at this boundary so a corrupt or future row can be repaired without failing
 * the full domain-service composition root.
 */
export class SessionsModel {
    /**
     * Per-lifetime totals behind {@link SessionStateUnchangedWrite}.
     */
    private readonly stateWrites = { total: 0, unchanged: 0 };

    constructor(
        private readonly database: CaxriDrizzleDatabase,
        private readonly onStateRepair?: (repair: SessionStateRepair) => void,
        private readonly onStateUnchanged?: (report: SessionStateUnchangedWrite) => void,
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
            .orderBy(asc(terminals.orderIndex))
            .all()
            .map((terminal) => terminal.id);
    }

    private orderedTerminalIdsBySession(): ReadonlyMap<string, readonly string[]> {
        const terminalIdsBySession = new Map<string, string[]>();
        const rows = this.database
            .select({ id: terminals.id, sessionId: terminals.sessionId })
            .from(terminals)
            .orderBy(asc(terminals.sessionId), asc(terminals.orderIndex))
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
            // No stored row to be stale against, so the first write must declare `0`.
            revision: 0,
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
            // The reader must be handed the revision the repair just stored, not the one it read: returning the older
            // token would make the client's first ordinary write look stale and be rejected for the Server's own edit.
            return { ...repaired, revision: this.updateState(repaired, ownedTerminalIds) };
        }
        /**
         * Repairing a row the Server itself could not parse is not a stale client write: it is based on the row that is
         * there right now, so it declares that row's revision rather than the fresh-Session `0`.
         */
        const repaired = {
            ...this.defaultState(row.sessionId, ownedTerminalIds),
            revision: row.revision,
        };
        const revision = this.updateState(repaired, ownedTerminalIds);
        this.onStateRepair?.({
            sessionId: row.sessionId,
            stateVersion: row.stateVersion,
            reason: parsed.reason,
        });
        return { ...repaired, revision };
    }

    /**
     * Applies a Terminal placement change to every Root the Session has already arranged. Terminal ownership is
     * Session-global, not Root-scoped (see {@link defaultPaneLayout}), so a create or close must stay visible no matter
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
        this.writeWorkbenchStates(sessionId, JSON.stringify(nextStates));
    }

    /**
     * The one way to rewrite a Session's stored Root arrangements outside {@link updateState}.
     *
     * Server-owned edits (a Terminal appearing in every Root, a deleted Project pruned out of them) change what a
     * client last read just as much as a client write does. Leaving `revision` untouched would let a Renderer holding
     * the pre-edit token write successfully and erase the edit, which is the exact race the token exists to stop. The
     * increment is a SQL expression so it is computed from the row being written, not from a value read earlier.
     */
    private writeWorkbenchStates(sessionId: string, workbenchStateJson: string): void {
        this.database
            .update(sessionStateTable)
            .set({ revision: sql`${sessionStateTable.revision} + 1`, workbenchStateJson })
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
            if (pruned !== undefined) this.writeWorkbenchStates(row.sessionId, pruned);
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
     * Lifts these Sessions above every other row in their Projects while keeping the batch's own order. Each statement
     * re-reads the table's lower bound, so walking the batch backwards leaves its first entry with the lowest position:
     * the same expression one activity promotion uses, rather than a second way of computing "top".
     */
    moveToSidebarTop(ids: readonly string[]): void {
        for (const id of ids.toReversed())
            this.database
                .update(sessions)
                .set({ sidebarOrder: sidebarTopOrder() })
                .where(eq(sessions.id, id))
                .run();
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
     *
     * Archiving also clears the pin: the Pinned group lists active Sessions, and a row that is archived and pinned at
     * once would be hidden from its Project group while still sitting at the top of the sidebar. Unarchiving therefore
     * does not restore the pin: the user pins it again if they still want it there.
     */
    setArchived(id: string, archivedAt: number | null): boolean {
        return (
            this.database
                .update(sessions)
                .set(archivedAt === null ? { archivedAt } : { archivedAt, pinnedAt: null })
                .where(eq(sessions.id, id))
                .run().changes === 1
        );
    }

    /**
     * Pins or unpins one Session. A fresh pin lands after every Session already in the Pinned group, matching where the
     * group renders it; unpinning leaves `pinnedOrder` behind because `pinnedAt` alone decides membership and the stale
     * number is overwritten by the next pin.
     */
    setPinned(id: string, pinnedAt: number | null): boolean {
        const pinnedOrder =
            pinnedAt === null
                ? undefined
                : sql<number>`COALESCE((SELECT MAX(${sessions.pinnedOrder}) + 1 FROM ${sessions} WHERE ${sessions.pinnedAt} IS NOT NULL), 0)`;
        return (
            this.database
                .update(sessions)
                .set(pinnedOrder === undefined ? { pinnedAt } : { pinnedAt, pinnedOrder })
                .where(eq(sessions.id, id))
                .run().changes === 1
        );
    }

    /**
     * The facade validates membership and owns the transaction, exactly as it does for `reorder`.
     */
    reorderPinned(sessionIds: readonly string[]): void {
        for (const [pinnedOrder, id] of sessionIds.entries())
            this.database.update(sessions).set({ pinnedOrder }).where(eq(sessions.id, id)).run();
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
                revision: sessionStateTable.revision,
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
                revision: sessionStateTable.revision,
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

    /**
     * Replaces one Session's stored state, rejecting a write assembled from a state that has since moved.
     *
     * The check is whole-write, not per field: the pane layout is a tree, so merging two arrangements field by field
     * would produce a third one neither writer asked for. A caller whose revision no longer matches is told the current
     * revision in `details` and re-derives its change against the fresh state instead.
     *
     * @returns The revision now stored, which the caller must adopt before writing again.
     */
    updateState(state: SessionState, terminalIds?: readonly string[]): number {
        const binding = this.getWorkbenchBinding(state.sessionId);
        if (!binding) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (binding.workbenchProjectId !== state.workbenchProjectId)
            throw new CaxriError('CONFLICT', 'Session state belongs to a stale Workbench Root');
        const existing = this.database
            .select({
                revision: sessionStateTable.revision,
                stateVersion: sessionStateTable.stateVersion,
                workbenchStateJson: sessionStateTable.workbenchStateJson,
                desiredSecondarySidebarViewContainerId:
                    sessionStateTable.desiredSecondarySidebarViewContainerId,
            })
            .from(sessionStateTable)
            .where(eq(sessionStateTable.sessionId, state.sessionId))
            .get();
        // No row yet means nothing can be stale against it, so a first write declares `0`.
        const storedRevision = existing?.revision ?? 0;
        if (state.revision !== storedRevision)
            throw new CaxriError(
                'CONFLICT',
                'Session state was written from a stale revision',
                // The current revision travels with the rejection so the writer can rebase without another read.
                { currentRevision: storedRevision, writtenRevision: state.revision },
            );
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
        const isUnchanged =
            existing?.stateVersion === CURRENT_SESSION_STATE_VERSION &&
            existing.workbenchStateJson === JSON.stringify(workbenchStates) &&
            existing.desiredSecondarySidebarViewContainerId ===
                state.desiredSecondarySidebarViewContainerId;
        const values = {
            sessionId: state.sessionId,
            /**
             * Only a write that actually changes the row advances the revision. Bumping on a no-op would invalidate a
             * concurrent writer's perfectly current revision for no observable reason.
             */
            revision: isUnchanged ? storedRevision : storedRevision + 1,
            stateVersion: CURRENT_SESSION_STATE_VERSION,
            workbenchStateJson: JSON.stringify(workbenchStates),
            desiredSecondarySidebarViewContainerId: state.desiredSecondarySidebarViewContainerId,
        };
        this.stateWrites.total += 1;
        if (isUnchanged) {
            this.stateWrites.unchanged += 1;
            this.onStateUnchanged?.({
                sessionId: state.sessionId,
                workbenchProjectId: state.workbenchProjectId,
                unchangedWrites: this.stateWrites.unchanged,
                totalWrites: this.stateWrites.total,
            });
        }
        this.database
            .insert(sessionStateTable)
            .values(values)
            .onConflictDoUpdate({
                target: sessionStateTable.sessionId,
                set: {
                    revision: values.revision,
                    stateVersion: values.stateVersion,
                    workbenchStateJson: values.workbenchStateJson,
                    desiredSecondarySidebarViewContainerId:
                        values.desiredSecondarySidebarViewContainerId,
                },
            })
            .run();
        return values.revision;
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
