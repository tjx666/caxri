import type { BootstrapState, SessionState } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import { isEqual } from 'es-toolkit';

import { mergeExternalEditorTabs } from '../features/editor/external-editor-state';

/**
 * Counts the writes this Renderer has started for any Session, so a resolving request can tell whether it is still the
 * newest attempt for its Session or has already been superseded locally.
 *
 * Deliberately not called a revision: {@link SessionState.revision} is the Server's stored-state token and answers a
 * different question: whether some _other_ writer has moved the row since this one read it.
 */
export const sessionPatchAttempt = { current: 0 };
/**
 * Monotonic count of `session.updateState` requests issued so far. Stamped on a write when it is _sent_, not when it
 * resolves: over a single serialized Server connection, any read issued after that point is guaranteed to observe the
 * write once it lands, regardless of which of the two responses comes back first. Comparing against resolution time
 * instead (as this used to) made a read whose response simply arrived first look "older" than a write it actually
 * postdated, so a `state.changed`-triggered refresh for an unrelated later mutation (e.g. closing a Terminal) could be
 * discarded in favor of a stale pre-mutation snapshot that never actually raced it.
 */
export const sessionStateWrites = { sent: 0 };
export const pendingSessionPatches = new Map<
    string,
    { attempt: number; retained?: boolean; sendStamp: number; state: SessionState }
>();
/**
 * The latest Session state whose `session.updateState` completed, kept until a bootstrap read issued after the write
 * proves the Server snapshot includes it. `pendingSessionPatches` only shields the in-flight window; without this map a
 * snapshot read issued before the write but resolved after it would silently roll the UI back (observed as a Terminal
 * split collapsing right after the drop persisted).
 */
export const persistedSessionPatches = new Map<
    string,
    { sendStamp: number; state: SessionState }
>();
/**
 * The write currently in flight for a Session, resolving with the revision the Server stored for it, or `undefined`
 * when it failed and stored nothing.
 *
 * Two layout changes in the same frame (a Terminal attaching while the pane it lives in is still being arranged) both
 * read {@link SessionState.revision} from the same optimistic overlay, because the first write has not answered yet.
 * Sent as-is, the second one declares a revision the first has already advanced and the Server rejects it as stale: a
 * lost race this Renderer had with nobody but itself, which would drop the user's newer change for no reason. Chaining
 * through this map makes the second write wait for the first and adopt the revision it stored, so `CONFLICT` keeps its
 * real meaning: some _other_ writer moved the row.
 */
export const sessionStateWriteChains = new Map<string, Promise<number | undefined>>();

/**
 * Rebases one write onto the revision the write before it stored, leaving everything else the caller assembled intact.
 *
 * Only the token is stale: both writes came from this Renderer, so the later layout was already built on top of the
 * earlier one through the optimistic overlay.
 */
export function rebasedSessionState(state: SessionState, stored: number | undefined): SessionState {
    return stored === undefined || stored === state.revision
        ? state
        : { ...state, revision: stored };
}

/**
 * Clears every overlay and write chain between tests.
 *
 * These are module singletons for the same reason the store is: one Renderer, one Server connection. A spec that leaves
 * a write deliberately unresolved would otherwise hand its chain to the next spec's write for the same Session, which
 * then waits forever for a request nobody is going to answer.
 */
export function resetSessionPatchesForTests(): void {
    pendingSessionPatches.clear();
    persistedSessionPatches.clear();
    sessionStateWriteChains.clear();
    sessionPatchAttempt.current = 0;
    sessionStateWrites.sent = 0;
}

export function sessionPatchKey(
    state: Pick<SessionState, 'sessionId' | 'workbenchProjectId'>,
): string {
    return `${state.sessionId}\0${state.workbenchProjectId}`;
}

/**
 * Whether the Server refused this write because the state it was assembled from has since moved.
 *
 * `CONFLICT` is the Server's answer to a lost race, not to a broken request: the writer read revision N, somebody else
 * stored N+1, and this write would have silently overwritten it. It is the one failure that must not roll back, because
 * the state to roll back to is exactly the one that turned out to be stale.
 */
export function isStaleSessionStateWrite(error: unknown): boolean {
    return isCaxriError(error) && error.code === 'CONFLICT';
}

/**
 * What the Workbench must show once `session.updateState` resolves.
 *
 * The Server answers with the state it actually stored, which can differ from what was sent: a layout that still
 * carried a Terminal closed while this write was being assembled comes back pruned. Showing the answer rather than the
 * optimistic copy is what stops that tab from lingering as a blank pane, because {@link persistedSessionPatches} would
 * otherwise re-apply the stale layout over every later snapshot.
 *
 * The answer is treated as untrusted input for the same reason snapshots are: a write that the Server confirmed must
 * never be rolled back, or reported as failed, merely because its response body could not be read.
 */
export function settledSessionState(sent: SessionState, answer: unknown): SessionState {
    const stored = answer as SessionState | undefined;
    if (
        stored?.sessionId !== sent.sessionId ||
        stored.workbenchProjectId !== sent.workbenchProjectId
    )
        return sent;
    const visible = mergeExternalEditorTabs(stored);
    if (!isEqual(visible.paneLayout, sent.paneLayout)) return visible;
    /**
     * The layout matched, but the revision cannot be dropped with the rest of the answer: it is the token the _next_
     * write has to declare. Keeping the one this write was assembled from would make every second write look stale to
     * the Server and be rejected.
     */
    return visible.revision === sent.revision ? sent : { ...sent, revision: visible.revision };
}

/**
 * A bootstrap read started before `session.updateState` can resolve after the optimistic Renderer write. Preserve the
 * latest unacknowledged Session state so that stale Server snapshots cannot make a just-selected tab or layout visibly
 * jump backwards.
 */
export function applyPendingSessionPatches(
    state: BootstrapState,
    readStamp: number,
): BootstrapState {
    // A read issued after a write was sent observes it once it lands (Server serializes requests in
    // arrival order), so the snapshot is authoritative for that Session again and the persisted overlay
    // can retire.
    for (const [key, entry] of persistedSessionPatches)
        if (entry.sendStamp <= readStamp) persistedSessionPatches.delete(key);
    if (pendingSessionPatches.size === 0 && persistedSessionPatches.size === 0) return state;
    const sessionStates = state.sessionStates.map((sessionState) => {
        const key = sessionPatchKey(sessionState);
        const pending = pendingSessionPatches.get(key);
        if (pending && (pending.retained || pending.sendStamp > readStamp)) return pending.state;
        const persisted = persistedSessionPatches.get(key);
        if (persisted && persisted.sendStamp > readStamp) return persisted.state;
        return sessionState;
    });
    return { ...state, sessionStates };
}
