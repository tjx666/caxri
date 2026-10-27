import type { SessionState } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { eq, sql } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { sessionViews as sessionViewsTable } from '../schema';
import type { WorkbenchEditorStates } from './workbench-editor-state';
import { parseWorkbenchEditorStates } from './workbench-editor-state';

/**
 * Every writer that can advance a Session state revision. A rejected write names the last of them, so a layout change
 * that silently reverts can be traced to whatever moved the row underneath it (issue #1743).
 *
 * - `clientWrite`: a `session.updateState` request.
 * - `serviceWrite`: a Server service writing a whole state the same way (Agent delegation placing its Terminal, an Agent
 *   dispatch restoring the layout after a launch failed to prepare).
 * - `rootFirstVisit`: a read storing the first snapshot of a Workbench Root the Session never arranged.
 * - `terminalTabRepair`: a read reconciling stored tabs with the Terminals the Session owns.
 * - `unreadableRepair`: a read replacing a row the Server could not parse.
 * - `terminalCreated`, `terminalClosed`, `terminalMovedAway`: a Terminal placement applied to every arranged Root.
 * - `projectPruned`: a deleted Project removed from every stored Root arrangement.
 */
export type SessionStateWriteReason =
    | 'clientWrite'
    | 'serviceWrite'
    | 'rootFirstVisit'
    | 'terminalTabRepair'
    | 'unreadableRepair'
    | 'terminalCreated'
    | 'terminalClosed'
    | 'terminalMovedAway'
    | 'projectPruned';

export interface SessionStateRevisionAdvance {
    sessionId: string;
    reason: Exclude<SessionStateWriteReason, 'clientWrite'>;
    /**
     * The revision this write stored.
     */
    revision: number;
}

/**
 * A write rejected because the revision it was assembled from is no longer the stored one.
 */
export interface SessionStateStaleWrite {
    sessionId: string;
    currentRevision: number;
    writtenRevision: number;
    /**
     * `unrecorded` when nothing advanced this Session's revision during this Server Core lifetime, so the stale token
     * predates the process (or its write was evicted from the bounded ledger).
     */
    lastWriteReason: SessionStateWriteReason | 'unrecorded';
    /**
     * The revision the last recorded write stored. It differs from `currentRevision` when that write's transaction
     * rolled back after the statement ran, or when a writer outside this ledger moved the row since.
     */
    lastWriteRevision: number | null;
    lastWriteAgeMs: number | null;
}

export interface SessionStateRevisionObservers {
    /**
     * Every Server-owned advance. Client writes are only remembered: they are the hot path, one per layout change.
     */
    onRevisionAdvanced?: (advance: SessionStateRevisionAdvance) => void;
    onStaleWrite?: (staleWrite: SessionStateStaleWrite) => void;
}

/**
 * Bounds the in-memory ledger. One entry per recently written Session is far more than a conflict needs, and a long
 * lifetime that creates and deletes many Sessions must not grow it without limit.
 */
const MAX_TRACKED_SESSIONS = 512;

/**
 * Owns the revision bookkeeping of `session_views`: the Server-owned rewrites that advance it outside
 * `SessionsModel.updateState`, the last writer of each Session, and the stale-write rejection.
 *
 * The last writer is in memory only. It answers "who moved this row, and when" for a conflict in the same Server Core
 * lifetime, which is the question the rejection itself cannot answer; it is deliberately not durable state.
 */
export class SessionStateRevisions {
    private readonly lastWrites = new Map<
        string,
        { reason: SessionStateWriteReason; revision: number; at: number }
    >();

    constructor(
        private readonly database: CaxriDrizzleDatabase,
        private readonly observers: SessionStateRevisionObservers = {},
    ) {}

    /**
     * Remembers a write that advanced the revision. Recorded when the statement runs, inside the caller's transaction.
     */
    recordWrite(sessionId: string, reason: SessionStateWriteReason, revision: number): void {
        // Re-inserting moves the Session to the newest end, so eviction drops the least recently written one.
        this.lastWrites.delete(sessionId);
        this.lastWrites.set(sessionId, { reason, revision, at: Date.now() });
        if (this.lastWrites.size > MAX_TRACKED_SESSIONS)
            this.lastWrites.delete(this.lastWrites.keys().next().value!);
        if (reason !== 'clientWrite')
            this.observers.onRevisionAdvanced?.({ sessionId, reason, revision });
    }

    /**
     * Reports a stale write and returns the rejection to throw. The current revision travels with it so the writer can
     * rebase without another read.
     */
    staleWrite(sessionId: string, currentRevision: number, writtenRevision: number): CaxriError {
        const last = this.lastWrites.get(sessionId);
        this.observers.onStaleWrite?.({
            sessionId,
            currentRevision,
            writtenRevision,
            lastWriteReason: last?.reason ?? 'unrecorded',
            lastWriteRevision: last?.revision ?? null,
            lastWriteAgeMs: last ? Date.now() - last.at : null,
        });
        return new CaxriError('CONFLICT', 'Session state was written from a stale revision', {
            currentRevision,
            writtenRevision,
        });
    }

    /**
     * Applies a Terminal placement change to every Root the Session has already arranged. Terminal ownership is
     * Session-global, not Root-scoped, so a create or close must stay visible no matter which Root the Session displays
     * next, not just the one selected right now. A Root with no stored snapshot yet is left alone: its first visit
     * builds a layout straight from `terminals`, so it can never drift out of sync in the first place.
     */
    mutateTerminalAcrossRootStates(
        sessionId: string,
        reason: 'terminalCreated' | 'terminalClosed' | 'terminalMovedAway',
        mutate: (paneLayout: SessionState['paneLayout']) => SessionState['paneLayout'],
    ): void {
        const row = this.database
            .select({ rootsJson: sessionViewsTable.rootsJson })
            .from(sessionViewsTable)
            .where(eq(sessionViewsTable.sessionId, sessionId))
            .get();
        if (!row) return;
        const states = parseWorkbenchEditorStates(row.rootsJson);
        if (!states) return;
        let isChanged = false;
        const nextStates: WorkbenchEditorStates = {};
        for (const [workbenchRootProjectId, rootState] of Object.entries(states)) {
            if (!rootState) continue;
            const paneLayout = mutate(rootState.paneLayout);
            if (paneLayout !== rootState.paneLayout) isChanged = true;
            nextStates[workbenchRootProjectId] =
                paneLayout === rootState.paneLayout ? rootState : { ...rootState, paneLayout };
        }
        if (!isChanged) return;
        this.rewriteRootStates(sessionId, JSON.stringify(nextStates), reason);
    }

    /**
     * The one way to rewrite a Session's stored Root arrangements outside `SessionsModel.updateState`.
     *
     * Server-owned edits (a Terminal appearing in every Root, a deleted Project pruned out of them) change what a
     * client last read just as much as a client write does. Leaving `revision` untouched would let a Renderer holding
     * the pre-edit token write successfully and erase the edit, which is the exact race the token exists to stop. The
     * increment is a SQL expression so it is computed from the row being written, not from a value read earlier.
     */
    rewriteRootStates(
        sessionId: string,
        rootsJson: string,
        reason: Exclude<SessionStateWriteReason, 'clientWrite' | 'serviceWrite'>,
    ): void {
        /**
         * `all()` rather than `get()`: no row matches a Session without stored state, and Drizzle types `get()` as
         * always returning one. The primary key bounds this to a single row.
         */
        const written = this.database
            .update(sessionViewsTable)
            .set({ revision: sql`${sessionViewsTable.revision} + 1`, rootsJson })
            .where(eq(sessionViewsTable.sessionId, sessionId))
            .returning({ revision: sessionViewsTable.revision })
            .all();
        for (const { revision } of written) this.recordWrite(sessionId, reason, revision);
    }
}
