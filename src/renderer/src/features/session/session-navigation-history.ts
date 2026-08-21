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
 * Folds an observed Session selection into the history, browser-style.
 *
 * `pending` carries the direction the user asked for, so the selection a `Go Back` triggered moves the current Session
 * onto the forward stack instead of pushing a new visit. It is honored only when the arriving Session is the one that
 * direction actually pointed at; any other selection (the user clicked a Session while the request was in flight, or
 * the Runtime selected one on its own) is an ordinary visit, which is what clears a stale pending direction.
 */
export function recordSessionVisit(
    snapshot: SessionNavigationHistorySnapshot,
    next: string | undefined,
    pending?: SessionNavigationDirection,
): SessionNavigationHistorySnapshot {
    const { back, current, forward } = snapshot;
    if (next === current) return snapshot;
    if (next === undefined) return { back, current: undefined, forward };
    if (current === undefined) return { back, current: next, forward };
    if (pending === 'back' && back.at(-1) === next) {
        return { back: back.slice(0, -1), current: next, forward: pushCapped(forward, current) };
    }
    if (pending === 'forward' && forward.at(-1) === next) {
        return { back: pushCapped(back, current), current: next, forward: forward.slice(0, -1) };
    }
    // An ordinary visit truncates the forward history, exactly like following a link in a browser.
    return { back: pushCapped(back, current), current: next, forward: [] };
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
    const back = snapshot.back.filter((sessionId) => active.has(sessionId));
    const forward = snapshot.forward.filter((sessionId) => active.has(sessionId));
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

interface SessionNavigationHistoryState extends SessionNavigationHistorySnapshot {
    pending?: SessionNavigationDirection;
    /**
     * Records the Session the workbench actually shows. Every selection path (Sidebar, palette, MRU switcher, Session
     * creation, a Runtime-driven switch) funnels through the observed selection rather than through each call site, so
     * no navigation source can forget to write history. Re-observing the same Session is a no-op, which also makes the
     * React StrictMode double effect harmless.
     */
    observe(sessionId?: string): void;
    prune(activeSessionIds: readonly string[]): void;
    /**
     * Claims the next target in `direction` and marks the resulting selection as history navigation.
     */
    request(direction: SessionNavigationDirection): string | undefined;
    reset(): void;
}

export const useSessionNavigationHistoryStore = create<SessionNavigationHistoryState>(
    (set, get) => ({
        ...EMPTY_SNAPSHOT,
        pending: undefined,
        observe: (sessionId) =>
            set((state) => {
                /*
                 * A refresh that reports the Session already on screen must not clear `pending`: a `Go Back` request
                 * can land after an unrelated snapshot refresh, and consuming the direction here would turn the
                 * navigation that follows into an ordinary visit.
                 */
                if (sessionId === state.current) return state;
                return {
                    ...recordSessionVisit(state, sessionId, state.pending),
                    pending: undefined,
                };
            }),
        prune: (activeSessionIds) => set((state) => pruneSessionHistory(state, activeSessionIds)),
        request: (direction) => {
            const target = sessionNavigationTarget(get(), direction);
            if (target) set({ pending: direction });
            return target;
        },
        reset: () => set({ ...EMPTY_SNAPSHOT, pending: undefined }),
    }),
);
