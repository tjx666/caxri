import { createStore } from '../../lib/store';
import { selectSelectedSession } from '../../stores/selectors';
import { useWorkbenchStore } from '../../stores/workbench';

/**
 * Upper bound on remembered visits. VS Code caps its editor navigation history for the same reason: an unbounded stack
 * turns a long-running window into a list nobody can walk back through anyway.
 */
const HISTORY_LIMIT = 50;

/**
 * Upper bound on unconfirmed navigations. A human cannot outrun a healthy Server by more than a step or two; a queue
 * this deep means the Server stopped answering, and letting it grow would keep firing selections it replays all at once
 * on recovery.
 */
const MAX_PENDING_NAVIGATIONS = 16;

export type SessionNavigationDirection = 'back' | 'forward';

/**
 * The visit timeline and the cursor into it, modeled the way a browser models its own back/forward list.
 *
 * A pair of stacks cannot express this domain: Session selection round-trips to the Server, so a confirmation may
 * arrive out of order, may fail while a later one succeeds, or may never arrive at all because `refreshWorkbench`
 * folded two selections into a single snapshot. Answering "where did the Workbench actually land" then requires an
 * absolute position, which a count of steps cannot name.
 */
export interface SessionHistoryTimeline {
    /**
     * Visited Sessions in order, oldest first.
     */
    entries: string[];
    /**
     * Position of the Session on screen, or, while {@link hasCurrent} is false, of the last one that was. `-1` only when
     * nothing before the first entry survives.
     */
    index: number;
    /**
     * False while the Workbench shows no Session at all. Its `index` entry is then the next `back` target rather than
     * the Session on screen, so returning to it stays possible.
     */
    hasCurrent: boolean;
}

/**
 * The timeline as the navigation controls consume it.
 */
export interface SessionNavigationHistorySnapshot {
    /**
     * Sessions visited before the one on screen, oldest first; the last entry is the next `back` target.
     */
    back: string[];
    /**
     * Sessions stepped back from, in the order `forward` will replay them.
     */
    forward: string[];
    current?: string;
}

export const EMPTY_SESSION_HISTORY: SessionHistoryTimeline = {
    entries: [],
    index: -1,
    hasCurrent: false,
};

export function sessionHistorySnapshot(
    timeline: SessionHistoryTimeline,
): SessionNavigationHistorySnapshot {
    const { entries, hasCurrent, index } = timeline;
    return {
        back: entries.slice(0, hasCurrent ? Math.max(index, 0) : index + 1),
        current: hasCurrent ? entries[index] : undefined,
        forward: entries.slice(index + 1).toReversed(),
    };
}

/**
 * The position `direction` leads to, or nothing when that direction has run out.
 */
export function sessionHistoryTarget(
    timeline: SessionHistoryTimeline,
    direction: SessionNavigationDirection,
): number | undefined {
    const { entries, hasCurrent, index } = timeline;
    // Without a current Session the entry at `index` is itself the next `back` target: it is the last one displayed.
    const next = direction === 'back' ? (hasCurrent ? index - 1 : index) : index + 1;
    return next >= 0 && next < entries.length ? next : undefined;
}

/**
 * Folds an ordinary Session selection into the timeline: the forward entries are dropped and the Session becomes the
 * newest one, exactly like following a link in a browser. History navigation goes through
 * {@link selectSessionHistoryIndex} instead, because it moves the cursor without rewriting the timeline.
 */
export function recordSessionVisit(
    timeline: SessionHistoryTimeline,
    sessionId: string | undefined,
): SessionHistoryTimeline {
    const { entries, hasCurrent, index } = timeline;
    if (sessionId === undefined)
        return hasCurrent ? { entries, hasCurrent: false, index } : timeline;
    if (entries[index] === sessionId) {
        // Re-selecting the Session the timeline already ends on is a refresh, not a visit, and after the Workbench
        // showed nothing at all, it restores the cursor rather than recording the same Session twice.
        return hasCurrent ? timeline : { entries, hasCurrent: true, index };
    }
    const kept = [...entries.slice(0, index + 1), sessionId];
    const overflow = Math.max(0, kept.length - HISTORY_LIMIT);
    return { entries: kept.slice(overflow), hasCurrent: true, index: kept.length - 1 - overflow };
}

/**
 * Moves the cursor to a confirmed position without touching the timeline itself.
 */
function selectSessionHistoryIndex(
    timeline: SessionHistoryTimeline,
    index: number,
): SessionHistoryTimeline {
    if (index < 0 || index >= timeline.entries.length) return timeline;
    return { ...timeline, hasCurrent: true, index };
}

/**
 * Drops Sessions that no longer exist or were archived, and reports where every surviving entry moved to so callers can
 * follow their own positions. Without this, `Go Back` would keep offering a deleted Session and quietly do nothing when
 * it is chosen.
 */
export function pruneSessionHistory(
    timeline: SessionHistoryTimeline,
    activeSessionIds: readonly string[],
): { positions: number[]; timeline: SessionHistoryTimeline } {
    const active = new Set(activeSessionIds);
    const entries: string[] = [];
    const positions = timeline.entries.map((sessionId) => {
        if (!active.has(sessionId)) return -1;
        // Pruning can leave a Session next to itself (`A → B → A` minus B). A repeat is a dead step: navigating to it
        // would re-select what is already on screen and leave the control enabled forever, so the two collapse into one.
        if (entries.at(-1) === sessionId) return entries.length - 1;
        entries.push(sessionId);
        return entries.length - 1;
    });
    if (entries.length === timeline.entries.length) return { positions, timeline };
    const survived = timeline.index >= 0 ? positions[timeline.index] : -1;
    return {
        positions,
        timeline: {
            entries,
            hasCurrent: timeline.hasCurrent && survived !== -1,
            // A current Session that was archived leaves the Workbench showing nothing of this timeline, so the cursor
            // falls back to the newest surviving entry before it, which is exactly where `back` should resume.
            index:
                survived === -1
                    ? Math.max(-1, ...positions.slice(0, Math.max(timeline.index, 0)))
                    : survived,
        },
    };
}

/**
 * A navigation the user asked for and the Server has not answered yet.
 */
export interface SessionNavigationRequest {
    /**
     * Distinguishes this request from every other one, including an earlier request for the same Session: an `A → B →
     * A` history queues two Backs to `A`, and matching a late failure by Session would cut the wrong one.
     */
    id: number;
    /**
     * The absolute position this request lands on. Confirmations are applied by position rather than by step count, so
     * one that arrives out of order (or that a folded Workbench snapshot skipped past) still lands correctly.
     */
    index: number;
    target: string;
}

interface SessionNavigationHistoryState extends SessionNavigationHistorySnapshot {
    canGoBack: boolean;
    canGoForward: boolean;
    /**
     * The timeline the Workbench has actually shown. Only a settled selection moves it, so no failed, overtaken, or
     * out-of-order request can corrupt it.
     */
    timeline: SessionHistoryTimeline;
    /**
     * Requested navigations still waiting for the Server, oldest first.
     */
    pending: SessionNavigationRequest[];
    /**
     * Selections dispatched to the Server and not yet settled, from every source. While any is outstanding the
     * Workbench snapshot is an echo of a selection that reports its own outcome, so observing it would apply the same
     * move twice, and, because `refreshWorkbench` folds a burst of refreshes into one snapshot, it would apply the
     * wrong one of several.
     */
    inFlight: number;
    /**
     * The Sessions the Workbench last reported as live, or nothing before the first report. A navigation that succeeds
     * only after its Session was archived must not write that Session back into a history it was just pruned out of.
     */
    liveSessionIds?: ReadonlySet<string>;
    nextRequestId: number;
    /**
     * Records a Session the Workbench shows that no dispatched selection accounts for: a Server-driven switch, or the
     * reconciliation after everything settles. Selections the Renderer issued report themselves instead.
     */
    recordWorkbenchSelection(sessionId?: string): void;
    prune(activeSessionIds: readonly string[]): void;
    /**
     * Registers a Session selection made by any other means. It is newer than every navigation still in flight, so
     * those stop projecting a destination the Workbench will never settle on.
     */
    beginSelection(): void;
    settleSelection(sessionId: string, isSelected: boolean): void;
    /**
     * Claims the next position in `direction`, or returns nothing when that direction is empty or too many navigations
     * are already unconfirmed. The caller reports the outcome back through `confirm` or `abandon`.
     */
    request(direction: SessionNavigationDirection): SessionNavigationRequest | undefined;
    confirm(request: SessionNavigationRequest): void;
    /**
     * Drops a navigation the Server refused. Later requests stay queued: their selections were already dispatched and
     * the Server's selection queue keeps running after a failure, so they will land and confirm themselves.
     */
    abandon(request: SessionNavigationRequest): void;
    reset(): void;
}

/**
 * Where the timeline would sit once every queued navigation lands. The controls read it and `request` computes from it,
 * so a second press composes with the first instead of recomputing from a state the screen has already left behind.
 */
function projectSessionHistory(
    timeline: SessionHistoryTimeline,
    pending: readonly SessionNavigationRequest[],
): SessionHistoryTimeline {
    const last = pending.at(-1);
    return last ? { ...timeline, hasCurrent: true, index: last.index } : timeline;
}

/**
 * Drops requests whose claimed position no longer holds the Session they were issued for. Recording a visit rewrites
 * the entries after the cursor, so a queued `Forward` can end up pointing at a Session that replaced its target; such a
 * request has to fall back to an ordinary visit instead of moving the cursor somewhere the user never went.
 */
function retainValidRequests(
    timeline: SessionHistoryTimeline,
    pending: SessionNavigationRequest[],
): SessionNavigationRequest[] {
    const valid = pending.filter((step) => timeline.entries[step.index] === step.target);
    return valid.length === pending.length ? pending : valid;
}

/**
 * Records a visit only while the Session is still live. A selection that succeeds after its Session was archived must
 * not write it back into a history the prune just took it out of: the active Session set does not change a second time,
 * so nothing would ever remove it again and Back would keep offering a target that can no longer be selected.
 */
function recordLiveVisit(
    state: SessionNavigationHistoryState,
    sessionId: string,
): SessionHistoryTimeline {
    if (state.liveSessionIds && !state.liveSessionIds.has(sessionId)) return state.timeline;
    return recordSessionVisit(state.timeline, sessionId);
}

/**
 * Where the Workbench actually ended up, folded in once nothing is left in flight.
 *
 * Snapshots taken while a selection is settling are ignored as that selection's own echo, but the Server can switch
 * Sessions on its own in that window: the current Session gets archived, or a Terminal moves to a new Session. Nothing
 * else would ever record it: the Session id does not change again, so no later snapshot arrives to observe.
 */
function reconcileWithWorkbench(timeline: SessionHistoryTimeline): SessionHistoryTimeline {
    const selected = selectSelectedSession(useWorkbenchStore.getState().bootstrap);
    return selected ? recordSessionVisit(timeline, selected.id) : timeline;
}

/**
 * `outstanding` is every dispatched-but-unsettled selection, not just the queued navigations: an ordinary selection
 * drops the navigations from `pending` without cancelling their IPCs, so counting `pending` alone would let each click
 * reopen the whole queue.
 */
function view(
    timeline: SessionHistoryTimeline,
    pending: SessionNavigationRequest[],
    outstanding: number,
) {
    const visible = projectSessionHistory(timeline, pending);
    // At the cap the controls have to report themselves as unavailable, or the button stays lit and does nothing.
    const isSaturated = outstanding >= MAX_PENDING_NAVIGATIONS;
    return {
        ...sessionHistorySnapshot(visible),
        canGoBack: !isSaturated && sessionHistoryTarget(visible, 'back') !== undefined,
        canGoForward: !isSaturated && sessionHistoryTarget(visible, 'forward') !== undefined,
        pending,
        timeline,
    };
}

/**
 * The state after one dispatched selection settles. The last one out of flight also reconciles with the Workbench, and
 * a queued navigation whose position that rewrote falls back to an ordinary visit.
 */
function settledView(
    timeline: SessionHistoryTimeline,
    pending: SessionNavigationRequest[],
    inFlight: number,
) {
    const reconciled = inFlight === 0 ? reconcileWithWorkbench(timeline) : timeline;
    return { ...view(reconciled, retainValidRequests(reconciled, pending), inFlight), inFlight };
}

export const useSessionNavigationHistoryStore = createStore<SessionNavigationHistoryState>(
    'session-navigation-history',
    (set, get) => ({
        ...view(EMPTY_SESSION_HISTORY, [], 0),
        inFlight: 0,
        nextRequestId: 1,
        recordWorkbenchSelection: (sessionId) =>
            set((state) => {
                if (state.inFlight > 0) return state;
                const timeline = recordSessionVisit(state.timeline, sessionId);
                return timeline === state.timeline
                    ? state
                    : view(timeline, state.pending, state.inFlight);
            }),
        prune: (activeSessionIds) =>
            set((state) => {
                const { positions, timeline } = pruneSessionHistory(
                    state.timeline,
                    activeSessionIds,
                );
                const pending = state.pending.flatMap((step) => {
                    const index = positions[step.index];
                    return index >= 0 && index < timeline.entries.length
                        ? [{ ...step, index }]
                        : [];
                });
                const liveSessionIds = new Set(activeSessionIds);
                if (timeline === state.timeline && pending.length === state.pending.length)
                    return { ...state, liveSessionIds };
                return { ...view(timeline, pending, state.inFlight), liveSessionIds };
            }),
        beginSelection: () =>
            set((state) => {
                const inFlight = state.inFlight + 1;
                return { ...view(state.timeline, [], inFlight), inFlight };
            }),
        settleSelection: (sessionId, isSelected) =>
            set((state) => {
                const inFlight = Math.max(0, state.inFlight - 1);
                // Even a refused selection settles: it frees a slot, and it can be the one that reconciles.
                const timeline = isSelected ? recordLiveVisit(state, sessionId) : state.timeline;
                return settledView(timeline, state.pending, inFlight);
            }),
        request: (direction) => {
            const state = get();
            // Measured against everything outstanding, not just the queue, so an ordinary selection that drops the
            // queue without cancelling its IPCs cannot reopen the cap.
            if (state.inFlight >= MAX_PENDING_NAVIGATIONS) return;
            const index = sessionHistoryTarget(
                projectSessionHistory(state.timeline, state.pending),
                direction,
            );
            if (index === undefined) return;
            const request = {
                id: state.nextRequestId,
                index,
                target: state.timeline.entries[index],
            };
            const inFlight = state.inFlight + 1;
            set({
                ...view(state.timeline, [...state.pending, request], inFlight),
                inFlight,
                nextRequestId: state.nextRequestId + 1,
            });
            return request;
        },
        confirm: (request) =>
            set((state) => {
                const inFlight = Math.max(0, state.inFlight - 1);
                const position = state.pending.findIndex((step) => step.id === request.id);
                if (position === -1) {
                    // Pruning or a newer selection already dropped this request, yet the Session did reach the screen,
                    // so it counts as an ordinary visit.
                    return settledView(
                        recordLiveVisit(state, request.target),
                        state.pending,
                        inFlight,
                    );
                }
                // Requests settle in dispatch order, so anything still queued ahead of this one was folded into the
                // same Workbench snapshot and is already accounted for by landing here.
                return settledView(
                    selectSessionHistoryIndex(state.timeline, request.index),
                    state.pending.slice(position + 1),
                    inFlight,
                );
            }),
        abandon: (request) =>
            set((state) => {
                const inFlight = Math.max(0, state.inFlight - 1);
                const pending = state.pending.filter((step) => step.id !== request.id);
                return settledView(state.timeline, pending, inFlight);
            }),
        // `liveSessionIds` belongs to the Workbench that is going away, so keeping it would judge the next Workbench's
        // Sessions against a Session set they were never part of, and every visit would be discarded as archived.
        reset: () =>
            set({ ...view(EMPTY_SESSION_HISTORY, [], 0), inFlight: 0, liveSessionIds: undefined }),
    }),
);
