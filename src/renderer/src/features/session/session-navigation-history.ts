import { create } from 'zustand';

/**
 * Upper bound on remembered visits. VS Code caps its editor navigation history for the same reason: an unbounded stack
 * turns a long-running window into a list nobody can walk back through anyway.
 */
const HISTORY_LIMIT = 50;

/**
 * Upper bound on unconfirmed navigations. A human cannot outrun a healthy Runtime by more than a step or two; a queue
 * this deep means the Runtime stopped answering, and letting it grow would keep firing selections it replays all at
 * once on recovery.
 */
const MAX_PENDING_NAVIGATIONS = 16;

export type SessionNavigationDirection = 'back' | 'forward';

/**
 * The visit timeline and the cursor into it, modeled the way a browser models its own back/forward list.
 *
 * A pair of stacks cannot express this domain: Session selection round-trips to the Runtime, so a confirmation may
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
     * Position of the Session on screen — or, while {@link hasCurrent} is false, of the last one that was. `-1` only
     * when nothing before the first entry survives.
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
        // Re-selecting the Session the timeline already ends on is a refresh, not a visit — and after the Workbench
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
            // falls back to the newest surviving entry before it — which is exactly where `back` should resume.
            index:
                survived === -1
                    ? Math.max(-1, ...positions.slice(0, Math.max(timeline.index, 0)))
                    : survived,
        },
    };
}

/**
 * A navigation the user asked for and the Runtime has not answered yet.
 */
export interface SessionNavigationRequest {
    /**
     * Distinguishes this request from every other one, including an earlier request for the same Session: an `A → B →
     * A` history queues two Backs to `A`, and matching a late failure by Session would cut the wrong one.
     */
    id: number;
    /**
     * The absolute position this request lands on. Confirmations are applied by position rather than by step count, so
     * one that arrives out of order — or that a folded Workbench snapshot skipped past — still lands correctly.
     */
    index: number;
    target: string;
}

interface SessionNavigationHistoryState extends SessionNavigationHistorySnapshot {
    canGoBack: boolean;
    canGoForward: boolean;
    /**
     * The timeline the Workbench has actually shown. Only a confirmed selection moves it, so no failed, overtaken, or
     * out-of-order request can corrupt it.
     */
    timeline: SessionHistoryTimeline;
    /**
     * Requested navigations still waiting for the Runtime, oldest first.
     */
    pending: SessionNavigationRequest[];
    nextRequestId: number;
    /**
     * Records the Session the Workbench actually shows. Every selection path (Sidebar, palette, MRU switcher, Session
     * creation, a Runtime-driven switch) funnels through the observed selection rather than through each call site, so
     * no navigation source can forget to write history.
     */
    observe(sessionId?: string): void;
    prune(activeSessionIds: readonly string[]): void;
    /**
     * Claims the next position in `direction`, or returns nothing when that direction is empty or too many navigations
     * are already unconfirmed. The caller reports the outcome back through `confirm` or `abandon`.
     */
    request(direction: SessionNavigationDirection): SessionNavigationRequest | undefined;
    confirm(request: SessionNavigationRequest): void;
    /**
     * Drops a navigation the Runtime refused. Later requests stay queued: their selections were already dispatched and
     * the Runtime's selection queue keeps running after a failure, so they will land and confirm themselves.
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

function view(timeline: SessionHistoryTimeline, pending: SessionNavigationRequest[]) {
    const visible = projectSessionHistory(timeline, pending);
    // At the cap the controls have to report themselves as unavailable, or the button stays lit and does nothing.
    const isSaturated = pending.length >= MAX_PENDING_NAVIGATIONS;
    return {
        ...sessionHistorySnapshot(visible),
        canGoBack: !isSaturated && sessionHistoryTarget(visible, 'back') !== undefined,
        canGoForward: !isSaturated && sessionHistoryTarget(visible, 'forward') !== undefined,
        pending,
        timeline,
    };
}

export const useSessionNavigationHistoryStore = create<SessionNavigationHistoryState>(
    (set, get) => ({
        ...view(EMPTY_SESSION_HISTORY, []),
        nextRequestId: 1,
        observe: (sessionId) =>
            set((state) => {
                // A Session a pending navigation is already heading to belongs to that request, which confirms itself
                // with the position it claimed. Recording it here would rewrite the timeline the request points into.
                if (
                    sessionId !== undefined &&
                    state.pending.some((step) => step.target === sessionId)
                )
                    return state;
                const timeline = recordSessionVisit(state.timeline, sessionId);
                if (timeline === state.timeline) return state;
                // Losing the current Session is not a selection taking over, so queued navigations survive it; an
                // ordinary selection of a different Session does supersede them.
                return view(timeline, sessionId === undefined ? state.pending : []);
            }),
        prune: (activeSessionIds) =>
            set((state) => {
                const { positions, timeline } = pruneSessionHistory(
                    state.timeline,
                    activeSessionIds,
                );
                const pending = state.pending
                    .map((step) => ({ ...step, index: positions[step.index] }))
                    .filter((step) => step.index >= 0 && step.index < timeline.entries.length);
                if (timeline === state.timeline && pending.length === state.pending.length)
                    return state;
                return view(timeline, pending);
            }),
        request: (direction) => {
            const state = get();
            if (state.pending.length >= MAX_PENDING_NAVIGATIONS) return;
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
            set({
                ...view(state.timeline, [...state.pending, request]),
                nextRequestId: state.nextRequestId + 1,
            });
            return request;
        },
        confirm: (request) =>
            set((state) => {
                const position = state.pending.findIndex((step) => step.id === request.id);
                if (position === -1) {
                    // Pruning or an overtaking selection already dropped this request, yet the Session did reach the
                    // screen — so it counts as an ordinary visit from wherever the Workbench actually ended up. Any
                    // remaining requests were computed against the timeline this rewrites and take the same path.
                    const timeline = recordSessionVisit(state.timeline, request.target);
                    return timeline === state.timeline ? state : view(timeline, []);
                }
                // Requests resolve in dispatch order, so anything still queued ahead of this one was folded into the
                // same Workbench snapshot and is already accounted for by landing here.
                return view(
                    selectSessionHistoryIndex(state.timeline, request.index),
                    state.pending.slice(position + 1),
                );
            }),
        abandon: (request) =>
            set((state) => {
                const pending = state.pending.filter((step) => step.id !== request.id);
                return pending.length === state.pending.length
                    ? state
                    : view(state.timeline, pending);
            }),
        reset: () => set(view(EMPTY_SESSION_HISTORY, [])),
    }),
);
