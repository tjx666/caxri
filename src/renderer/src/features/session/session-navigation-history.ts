import { create } from 'zustand';

/**
 * Upper bound on remembered visits. VS Code caps its editor navigation history for the same reason: an unbounded stack
 * turns a long-running window into a list nobody can walk back through anyway.
 */
const HISTORY_LIMIT = 50;

export type SessionNavigationDirection = 'back' | 'forward';

export interface SessionNavigationHistorySnapshot {
    /**
     * Sessions visited before {@link current}, oldest first; the last entry is the next `back` target.
     */
    back: string[];
    /**
     * Sessions stepped back from, in the order `forward` will replay them.
     */
    forward: string[];
    current?: string;
}

const EMPTY_SNAPSHOT: SessionNavigationHistorySnapshot = {
    back: [],
    current: undefined,
    forward: [],
};

function pushCapped(stack: readonly string[], sessionId: string): string[] {
    const next = [...stack, sessionId];
    return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

/**
 * Drops entries that repeat {@link SessionNavigationHistorySnapshot.current} at the top of a stack.
 *
 * A repeat deeper in a stack is real history (`A → B → A` genuinely visited A twice), but a repeat at the top is a dead
 * step: navigating to it would re-select the Session already on screen, leave the stack unchanged, and keep the button
 * enabled forever. Pruning an archived Session out of the middle is what creates them.
 */
function dropRedundantTop(stack: readonly string[], current: string | undefined): string[] {
    let end = stack.length;
    while (end > 0 && stack[end - 1] === current) end--;
    return end === stack.length ? [...stack] : stack.slice(0, end);
}

/**
 * Folds an ordinary Session selection into the history: the outgoing Session becomes the next `back` target and the
 * forward history is truncated, exactly like following a link in a browser.
 *
 * History navigation does not go through here — {@link applySessionNavigation} moves the stacks at request time so a
 * second navigation issued before the Runtime confirms the first still computes from the state the user can see.
 */
export function recordSessionVisit(
    snapshot: SessionNavigationHistorySnapshot,
    next: string | undefined,
): SessionNavigationHistorySnapshot {
    const { back, current, forward } = snapshot;
    if (next === current) return snapshot;
    if (next === undefined) return { back, current: undefined, forward };
    if (current === undefined) return { back, current: next, forward };
    return { back: pushCapped(back, current), current: next, forward: [] };
}

/**
 * Moves the stacks one step in `direction`, returning the snapshot unchanged when that direction has no target.
 */
export function applySessionNavigation(
    snapshot: SessionNavigationHistorySnapshot,
    direction: SessionNavigationDirection,
): SessionNavigationHistorySnapshot {
    const { back, current, forward } = snapshot;
    const target = sessionNavigationTarget(snapshot, direction);
    if (target === undefined || current === undefined) return snapshot;
    return direction === 'back'
        ? { back: back.slice(0, -1), current: target, forward: pushCapped(forward, current) }
        : { back: pushCapped(back, current), current: target, forward: forward.slice(0, -1) };
}

/**
 * Drops Sessions that no longer exist or were archived. Without this, `Go Back` would keep offering a deleted Session
 * and quietly do nothing when it is chosen.
 */
export function pruneSessionHistory(
    snapshot: SessionNavigationHistorySnapshot,
    activeSessionIds: readonly string[],
): SessionNavigationHistorySnapshot {
    const active = new Set(activeSessionIds);
    const isActive = (sessionId: string): boolean => active.has(sessionId);
    const back = dropRedundantTop(snapshot.back.filter(isActive), snapshot.current);
    const forward = dropRedundantTop(snapshot.forward.filter(isActive), snapshot.current);
    if (back.length === snapshot.back.length && forward.length === snapshot.forward.length) {
        return snapshot;
    }
    return { back, current: snapshot.current, forward };
}

export function sessionNavigationTarget(
    snapshot: SessionNavigationHistorySnapshot,
    direction: SessionNavigationDirection,
): string | undefined {
    return direction === 'back' ? snapshot.back.at(-1) : snapshot.forward.at(-1);
}

/**
 * A navigation the user has already asked for and the Runtime has not confirmed yet.
 */
interface QueuedSessionNavigation {
    direction: SessionNavigationDirection;
    target: string;
}

/**
 * Upper bound on unconfirmed navigations. A human cannot outrun a healthy Runtime by more than a step or two; a queue
 * this deep means the Runtime stopped answering, and letting it grow would keep firing selections and replay them all
 * once it recovers.
 */
const MAX_PENDING_NAVIGATIONS = 16;

/**
 * The history the user would see once every queued navigation lands. Buttons read it and `request` computes from it, so
 * a second press composes with the first instead of recomputing from a state the screen has already left behind.
 */
function projectSessionHistory(
    confirmed: SessionNavigationHistorySnapshot,
    queue: readonly QueuedSessionNavigation[],
): SessionNavigationHistorySnapshot {
    return queue.reduce(
        (snapshot, step) => applySessionNavigation(snapshot, step.direction),
        confirmed,
    );
}

interface SessionNavigationHistoryState extends SessionNavigationHistorySnapshot {
    /**
     * The history of Sessions the workbench has actually shown. Everything the user sees is projected from it, and it
     * only ever moves on a confirmed selection, so no failed or overtaken request can corrupt it.
     */
    confirmed: SessionNavigationHistorySnapshot;
    /**
     * Requested navigations still waiting for the Runtime, oldest first.
     */
    queue: QueuedSessionNavigation[];
    /**
     * Records the Session the workbench actually shows. Every selection path (Sidebar, palette, MRU switcher, Session
     * creation, a Runtime-driven switch) funnels through the observed selection rather than through each call site, so
     * no navigation source can forget to write history.
     *
     * A confirmation is matched against the oldest queued target rather than against the visible `current`, because
     * confirmations arrive late and in request order: after two quick Backs, the first one names a Session the screen
     * has already left. Anything else means an ordinary selection won the race and takes the history over from the last
     * Session that was really displayed.
     */
    observe(sessionId?: string): void;
    prune(activeSessionIds: readonly string[]): void;
    /**
     * Claims the next target in `direction` and returns the Session to select, or nothing when that direction is empty
     * or too many navigations are already unconfirmed.
     */
    request(direction: SessionNavigationDirection): string | undefined;
    /**
     * Drops a navigation the Runtime refused, along with every later one — those were computed on top of a step that
     * never happened. The confirmed history is untouched, so nothing pruned can come back and no successful step is
     * undone.
     */
    abandon(target: string): void;
    reset(): void;
}

function withQueue(
    confirmed: SessionNavigationHistorySnapshot,
    queue: QueuedSessionNavigation[],
): SessionNavigationHistorySnapshot & {
    confirmed: SessionNavigationHistorySnapshot;
    queue: QueuedSessionNavigation[];
} {
    return { ...projectSessionHistory(confirmed, queue), confirmed, queue };
}

export const useSessionNavigationHistoryStore = create<SessionNavigationHistoryState>(
    (set, get) => ({
        ...EMPTY_SNAPSHOT,
        confirmed: EMPTY_SNAPSHOT,
        queue: [],
        observe: (sessionId) =>
            set((state) => {
                const [oldest, ...rest] = state.queue;
                if (
                    sessionId !== undefined &&
                    state.queue.length > 0 &&
                    sessionId === oldest.target
                )
                    return withQueue(
                        applySessionNavigation(state.confirmed, oldest.direction),
                        rest,
                    );
                const confirmed = recordSessionVisit(state.confirmed, sessionId);
                // A snapshot that re-reports the Session already recorded changes nothing and must not disturb the
                // queue: it is a refresh, not a selection, and React StrictMode replays this effect too.
                if (confirmed === state.confirmed) return state;
                return withQueue(confirmed, []);
            }),
        prune: (activeSessionIds) =>
            set((state) => {
                const active = new Set(activeSessionIds);
                const stale = state.queue.findIndex((step) => !active.has(step.target));
                return withQueue(
                    pruneSessionHistory(state.confirmed, activeSessionIds),
                    stale === -1 ? state.queue : state.queue.slice(0, stale),
                );
            }),
        request: (direction) => {
            const state = get();
            const target = sessionNavigationTarget(state, direction);
            if (target === undefined || state.queue.length >= MAX_PENDING_NAVIGATIONS) return;
            set(withQueue(state.confirmed, [...state.queue, { direction, target }]));
            return target;
        },
        abandon: (target) =>
            set((state) => {
                const index = state.queue.findIndex((step) => step.target === target);
                return index === -1
                    ? state
                    : withQueue(state.confirmed, state.queue.slice(0, index));
            }),
        reset: () => set({ ...EMPTY_SNAPSHOT, confirmed: EMPTY_SNAPSHOT, queue: [] }),
    }),
);
