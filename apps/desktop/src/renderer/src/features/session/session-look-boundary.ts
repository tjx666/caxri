import { createStore } from '../../lib/store';

/**
 * What the Renderer knows about when the user last looked at each Session in this window. A restart forgets it; the
 * first look at a Session after that falls back to the durable boundary Server Core records from window presence
 * (`SessionRecord.lastViewedAt`), so the "since you last looked" hint still counts what finished while Caxri was
 * closed.
 */
export interface SessionLookState {
    /**
     * The Session being looked at right now: selected, in a visible, focused window. `undefined` otherwise.
     */
    watching: string | undefined;
    /**
     * When the user stopped looking at each Session they have left.
     */
    leftAt: Readonly<Partial<Record<string, number>>>;
    /**
     * The absence the user just returned from, per Session, until they dismiss it or leave again.
     */
    returns: Readonly<Partial<Record<string, { boundary: number; capturedAt: number }>>>;
}

export const initialSessionLookState: SessionLookState = {
    watching: undefined,
    leftAt: {},
    returns: {},
};

/**
 * The next state when the Session being looked at becomes `next` (or nothing) at `now`. Leaving a Session records the
 * boundary; looking at one again freezes the absence so the hint keeps counting against the same window while the
 * Renderer later marks the Session read. `persistedBoundary` is `next`'s durable last-viewed time, used only when this
 * window has not left `next` yet: an in-window leave is always newer.
 */
export function advanceSessionLook(
    state: SessionLookState,
    next: string | undefined,
    now: number,
    persistedBoundary?: number,
): SessionLookState {
    if (state.watching === next) return state;
    const leftAt = { ...state.leftAt };
    const returns = { ...state.returns };
    if (state.watching !== undefined) {
        leftAt[state.watching] = now;
        delete returns[state.watching];
    }
    if (next !== undefined) {
        const boundary = leftAt[next] ?? persistedBoundary;
        if (boundary !== undefined) {
            returns[next] = { boundary, capturedAt: now };
            delete leftAt[next];
        }
    }
    return { watching: next, leftAt, returns };
}

export function dismissSessionReturn(state: SessionLookState, sessionId: string): SessionLookState {
    if (!(sessionId in state.returns)) return state;
    const returns = { ...state.returns };
    delete returns[sessionId];
    return { ...state, returns };
}

export const useSessionLookStore = createStore<SessionLookState>(
    'session-look-boundary',
    () => initialSessionLookState,
);

export function setWatchedSession(
    sessionId: string | undefined,
    persistedBoundary?: number,
    now = Date.now(),
): void {
    useSessionLookStore.setState((state) =>
        advanceSessionLook(state, sessionId, now, persistedBoundary),
    );
}

export function dismissReturn(sessionId: string): void {
    useSessionLookStore.setState((state) => dismissSessionReturn(state, sessionId));
}
