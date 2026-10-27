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
    removePaneTerminal,
} from '@caxri/protocol';
import { and, asc, eq, lt, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import {
    CURRENT_SESSION_STATE_VERSION,
    sessions,
    sessionViews as sessionViewsTable,
    terminals,
} from '../schema';
import { didConsumeAttentionReply, didReleaseAttentionReply } from './attention-replies';
import { sessionActivityUpdate, sidebarTopOrder } from './session-activity';
import { didWriteAutomaticNaming, readAutomaticNaming } from './session-naming';
import {
    effectiveWorkbenchRootProjectId,
    mapSession,
    sessionSelection,
    workbenchProjects,
} from './session-record';
import type {
    SessionStateRevisionObservers,
    SessionStateWriteReason,
} from './session-state-revisions';
import { SessionStateRevisions } from './session-state-revisions';
import type {
    SessionStateRepair,
    SessionStateRow,
    SessionStateUnchangedWrite,
} from './session-state-row';
import { parseSessionState } from './session-state-row';
import {
    defaultSessionPaneLayout,
    reconcileOwnedTerminalTabs,
    resolveSessionPaneLayout,
} from './session-terminal-layout';
import type { WorkbenchEditorStates } from './workbench-editor-state';
import { parseWorkbenchEditorStates, pruneWorkbenchEditorState } from './workbench-editor-state';

export interface NewSessionInput {
    projectId: string;
    title: string;
    createdBySessionId?: string;
}

export interface SessionWorkbenchBinding {
    projectId: string;
    workbenchRootProjectId: string;
    rootDevice?: string;
    rootInode?: string;
}

/**
 * Pure CRUD over `sessions` and its 1:1 `session_views` child row. Primary-Agent succession, default titles, and
 * deletion-fallback selection are decided in `../session-policy.ts` and applied here through plain setters. Session
 * JSON is versioned and schema-validated at this boundary so a corrupt or future row can be repaired without failing
 * the full domain-service composition root.
 */
export class SessionsModel {
    /**
     * Per-lifetime totals behind {@link SessionStateUnchangedWrite}.
     */
    private readonly stateWrites = { total: 0, unchanged: 0 };
    private readonly revisions: SessionStateRevisions;

    constructor(
        private readonly database: CaxriDrizzleDatabase,
        private readonly onStateRepair?: (repair: SessionStateRepair) => void,
        private readonly onStateUnchanged?: (report: SessionStateUnchangedWrite) => void,
        revisionObservers?: SessionStateRevisionObservers,
    ) {
        this.revisions = new SessionStateRevisions(database, revisionObservers);
    }

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

    private defaultState(sessionId: string, terminalIds: readonly string[]): SessionState {
        const session = this.database
            .select({
                projectId: sessions.projectId,
                workbenchRootProjectId: sessions.workbenchRootProjectId,
            })
            .from(sessions)
            .where(eq(sessions.id, sessionId))
            .get();
        return {
            sessionId,
            // No stored row to be stale against, so the first write must declare `0`.
            revision: 0,
            workbenchRootProjectId: session?.workbenchRootProjectId ?? session?.projectId ?? '',
            desiredSecondarySidebarViewContainerId: 'caxri.files',
            paneLayout: defaultSessionPaneLayout(terminalIds),
        };
    }

    private readState(row: SessionStateRow, terminalIds?: readonly string[]): SessionState {
        const ownedTerminalIds = terminalIds ?? this.orderedTerminalIds(row.sessionId);
        const parsed = parseSessionState(row, () => defaultSessionPaneLayout(ownedTerminalIds));
        if ('state' in parsed) {
            const paneLayout = reconcileOwnedTerminalTabs(
                parsed.state.paneLayout,
                ownedTerminalIds,
            );
            // Persist a first visit before another bootstrap can generate different pane/tab IDs.
            if (paneLayout === parsed.state.paneLayout && !parsed.isNewRoot) return parsed.state;
            const repaired = { ...parsed.state, paneLayout };
            const reason = parsed.isNewRoot ? 'rootFirstVisit' : 'terminalTabRepair';
            // The reader must be handed the revision the repair just stored, not the one it read: returning the older
            // token would make the client's first ordinary write look stale and be rejected for the Server's own edit.
            return { ...repaired, revision: this.updateState(repaired, reason, ownedTerminalIds) };
        }
        /**
         * Repairing a row the Server itself could not parse is not a stale client write: it is based on the row that is
         * there right now, so it declares that row's revision rather than the fresh-Session `0`.
         */
        const repaired = {
            ...this.defaultState(row.sessionId, ownedTerminalIds),
            revision: row.revision,
        };
        const revision = this.updateState(repaired, 'unreadableRepair', ownedTerminalIds);
        this.onStateRepair?.({
            sessionId: row.sessionId,
            stateVersion: row.stateVersion,
            reason: parsed.reason,
        });
        return { ...repaired, revision };
    }

    list(projectId?: string): SessionRecord[] {
        const rows = projectId
            ? this.database
                  .select(sessionSelection)
                  .from(sessions)
                  .innerJoin(
                      workbenchProjects,
                      eq(workbenchProjects.id, effectiveWorkbenchRootProjectId),
                  )
                  .where(eq(sessions.projectId, projectId))
                  .orderBy(asc(sessions.createdAt), asc(sessions.id))
                  .all()
            : this.database
                  .select(sessionSelection)
                  .from(sessions)
                  .innerJoin(
                      workbenchProjects,
                      eq(workbenchProjects.id, effectiveWorkbenchRootProjectId),
                  )
                  .orderBy(asc(sessions.createdAt), asc(sessions.id))
                  .all();
        return rows.map(mapSession);
    }

    get(id: string): SessionRecord | undefined {
        const row = this.database
            .select(sessionSelection)
            .from(sessions)
            .innerJoin(workbenchProjects, eq(workbenchProjects.id, effectiveWorkbenchRootProjectId))
            .where(eq(sessions.id, id))
            .get();
        return row ? mapSession(row) : undefined;
    }

    getWorkbenchBinding(id: string): SessionWorkbenchBinding | undefined {
        const row = this.database
            .select({
                projectId: sessions.projectId,
                workbenchRootProjectId: sessions.workbenchRootProjectId,
                rootDevice: sessions.workbenchRootDevice,
                rootInode: sessions.workbenchRootInode,
            })
            .from(sessions)
            .where(eq(sessions.id, id))
            .get();
        if (!row) return undefined;
        return {
            projectId: row.projectId,
            workbenchRootProjectId: row.workbenchRootProjectId ?? row.projectId,
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
                    workbenchRootProjectId: isAlternate ? projectId : null,
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
            .where(eq(sessions.workbenchRootProjectId, projectId))
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
                sessionId: sessionViewsTable.sessionId,
                rootsJson: sessionViewsTable.rootsJson,
            })
            .from(sessionViewsTable)
            .all();
        for (const row of stateRows) {
            const pruned = pruneWorkbenchEditorState(row.rootsJson, projectId);
            if (pruned !== undefined)
                this.revisions.rewriteRootStates(row.sessionId, pruned, 'projectPruned');
        }
        const sessionIds = this.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.workbenchRootProjectId, projectId))
            .all()
            .map(({ id }) => id);
        if (sessionIds.length > 0)
            this.database
                .update(sessions)
                .set({
                    workbenchRootProjectId: null,
                    workbenchRootDevice: null,
                    workbenchRootInode: null,
                })
                .where(eq(sessions.workbenchRootProjectId, projectId))
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
                lastVisitedAt: now,
                ...sessionActivityUpdate('created', now),
                primaryAgentTerminalId: null,
                agentActivityState: 'idle',
                attentionGeneration: 0,
                acknowledgedAttentionGeneration: 0,
                lastAttentionKind: null,
                title: input.title,
                titleMode: 'automatic',
                createdBySessionId: input.createdBySessionId ?? null,
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
        const lastVisitedAt = sql<number>`MAX(${now}, COALESCE((SELECT MAX(${sessions.lastVisitedAt}) + 1 FROM ${sessions}), ${now}))`;
        return (
            this.database.update(sessions).set({ lastVisitedAt }).where(eq(sessions.id, id)).run()
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
            title: string;
            agentActivityState: AgentActivityState;
        },
    ): void {
        this.database
            .update(sessions)
            .set({
                primaryAgentTerminalId: patch.primaryAgentTerminalId,
                title: patch.title,
                agentActivityState: patch.agentActivityState,
            })
            .where(eq(sessions.id, id))
            .run();
    }

    setTitleAndActivity(
        id: string,
        title: string,
        agentActivityState: AgentActivityState,
        attentionKind?: SessionAttentionKind,
        activityReason?: SessionActivityReason,
    ): void {
        const now = Date.now();
        this.database
            .update(sessions)
            .set({
                title,
                agentActivityState,
                ...(attentionKind && {
                    attentionGeneration: sql`${sessions.attentionGeneration} + 1`,
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
    acknowledgeAttention(id: string, generation: number): boolean {
        return (
            this.database
                .update(sessions)
                .set({ acknowledgedAttentionGeneration: generation })
                .where(
                    and(
                        eq(sessions.id, id),
                        eq(sessions.attentionGeneration, generation),
                        lt(sessions.acknowledgedAttentionGeneration, generation),
                    ),
                )
                .run().changes === 1
        );
    }

    consumeAttentionReply(id: string, terminalId: string, generation: number): boolean {
        return didConsumeAttentionReply(this.database, id, terminalId, generation);
    }

    releaseAttentionReply(
        id: string,
        terminalId: string,
        generation: number,
        activityAt: number,
    ): boolean {
        return didReleaseAttentionReply(this.database, id, terminalId, generation, activityAt);
    }

    rename(id: string, title: string): boolean {
        return (
            this.database
                .update(sessions)
                .set({ title, titleMode: 'manual' })
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
        title?: string,
    ): boolean {
        return didWriteAutomaticNaming(this.database, id, value, title);
    }

    setActivityStateByPrimaryTerminal(
        terminalId: string,
        agentActivityState: AgentActivityState,
        activityReason?: SessionActivityReason,
    ): boolean {
        const now = Date.now();
        return (
            this.database
                .update(sessions)
                .set({
                    agentActivityState,
                    ...(activityReason && sessionActivityUpdate(activityReason, now)),
                })
                .where(eq(sessions.primaryAgentTerminalId, terminalId))
                .run().changes === 1
        );
    }

    getState(sessionId: string): SessionState {
        const row = this.database
            .select({
                sessionId: sessionViewsTable.sessionId,
                projectId: sessions.projectId,
                workbenchRootProjectId: sessions.workbenchRootProjectId,
                revision: sessionViewsTable.revision,
                stateVersion: sessionViewsTable.stateVersion,
                rootsJson: sessionViewsTable.rootsJson,
                desiredSecondarySidebarViewContainerId:
                    sessionViewsTable.desiredSecondarySidebarViewContainerId,
            })
            .from(sessionViewsTable)
            .innerJoin(sessions, eq(sessions.id, sessionViewsTable.sessionId))
            .where(eq(sessionViewsTable.sessionId, sessionId))
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
                sessionId: sessionViewsTable.sessionId,
                projectId: sessions.projectId,
                workbenchRootProjectId: sessions.workbenchRootProjectId,
                revision: sessionViewsTable.revision,
                stateVersion: sessionViewsTable.stateVersion,
                rootsJson: sessionViewsTable.rootsJson,
                desiredSecondarySidebarViewContainerId:
                    sessionViewsTable.desiredSecondarySidebarViewContainerId,
            })
            .from(sessionViewsTable)
            .innerJoin(sessions, eq(sessions.id, sessionViewsTable.sessionId))
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
            .insert(sessionViewsTable)
            .values({
                sessionId,
                stateVersion: CURRENT_SESSION_STATE_VERSION,
                desiredSecondarySidebarViewContainerId: 'caxri.files',
                rootsJson: JSON.stringify(
                    binding ? { [binding.workbenchRootProjectId]: { paneLayout } } : {},
                ),
            })
            .run();
    }

    /**
     * Replaces one Session's stored state, rejecting a write assembled from a state that has since moved.
     *
     * The check is whole-write, not per field: the pane layout is a tree, so merging two arrangements field by field
     * would produce a third one neither writer asked for. A caller whose revision no longer matches is told the current
     * revision in `details` and re-derives its change against the fresh state instead. `reason` names the writer for
     * the diagnostics of a later stale write; any write that is not a `session.updateState` request or a read repair is
     * a Server service writing a whole state.
     *
     * @returns The revision now stored, which the caller must adopt before writing again.
     */
    updateState(
        state: SessionState,
        reason: SessionStateWriteReason = 'serviceWrite',
        terminalIds?: readonly string[],
    ): number {
        const binding = this.getWorkbenchBinding(state.sessionId);
        if (!binding) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (binding.workbenchRootProjectId !== state.workbenchRootProjectId)
            throw new CaxriError('CONFLICT', 'Session state belongs to a stale Workbench Root');
        const existing = this.database
            .select({
                revision: sessionViewsTable.revision,
                stateVersion: sessionViewsTable.stateVersion,
                rootsJson: sessionViewsTable.rootsJson,
                desiredSecondarySidebarViewContainerId:
                    sessionViewsTable.desiredSecondarySidebarViewContainerId,
            })
            .from(sessionViewsTable)
            .where(eq(sessionViewsTable.sessionId, state.sessionId))
            .get();
        // No row yet means nothing can be stale against it, so a first write declares `0`.
        const storedRevision = existing?.revision ?? 0;
        if (state.revision !== storedRevision)
            throw this.revisions.staleWrite(state.sessionId, storedRevision, state.revision);
        const storedStates = existing ? parseWorkbenchEditorStates(existing.rootsJson) : undefined;
        const paneLayout = resolveSessionPaneLayout(
            state.paneLayout,
            storedStates?.[state.workbenchRootProjectId]?.paneLayout,
            terminalIds ?? this.orderedTerminalIds(state.sessionId),
        );
        // Only the selected Root's snapshot is rewritten; every other Root keeps the arrangement it was left in.
        const workbenchStates: WorkbenchEditorStates = {
            ...storedStates,
            [state.workbenchRootProjectId]: {
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
            existing.rootsJson === JSON.stringify(workbenchStates) &&
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
            rootsJson: JSON.stringify(workbenchStates),
            desiredSecondarySidebarViewContainerId: state.desiredSecondarySidebarViewContainerId,
        };
        this.stateWrites.total += 1;
        if (isUnchanged) {
            this.stateWrites.unchanged += 1;
            this.onStateUnchanged?.({
                sessionId: state.sessionId,
                workbenchRootProjectId: state.workbenchRootProjectId,
                unchangedWrites: this.stateWrites.unchanged,
                totalWrites: this.stateWrites.total,
            });
        }
        this.database
            .insert(sessionViewsTable)
            .values(values)
            .onConflictDoUpdate({
                target: sessionViewsTable.sessionId,
                set: {
                    revision: values.revision,
                    stateVersion: values.stateVersion,
                    rootsJson: values.rootsJson,
                    desiredSecondarySidebarViewContainerId:
                        values.desiredSecondarySidebarViewContainerId,
                },
            })
            .run();
        if (!isUnchanged) this.revisions.recordWrite(state.sessionId, reason, values.revision);
        return values.revision;
    }

    /**
     * Adds a newly created Terminal into every Root the Session has already arranged, so the next visit to any of them
     * shows it instead of only the Root that was active at creation time.
     */
    addTerminalToAllRootStates(sessionId: string, terminalId: string): void {
        this.revisions.mutateTerminalAcrossRootStates(sessionId, 'terminalCreated', (paneLayout) =>
            addPaneTerminalSilently(paneLayout, terminalId),
        );
    }

    /**
     * Drops a closed or moved-away Terminal from every Root the Session has already arranged, so no stored snapshot
     * keeps a tab pointing at a PTY it no longer owns.
     */
    removeTerminalFromAllRootStates(
        sessionId: string,
        terminalId: string,
        reason: 'terminalClosed' | 'terminalMovedAway',
    ): void {
        this.revisions.mutateTerminalAcrossRootStates(sessionId, reason, (paneLayout) =>
            removePaneTerminal(paneLayout, terminalId),
        );
    }
}
