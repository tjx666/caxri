import { createStore } from '../../lib/store';

/**
 * What the Renderer knows about when the user last looked at each Session, in memory only (a restart forgets it, and
 * the "since you last looked" hint is simply absent until the Session has been looked at once in this window).
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
 * Renderer later marks the Session read.
 */
export function advanceSessionLook(
    state: SessionLookState,
    next: string | undefined,
    now: number,
): SessionLookState {
    if (state.watching === next) return state;
    const leftAt = { ...state.leftAt };
    const returns = { ...state.returns };
    if (state.watching !== undefined) {
        leftAt[state.watching] = now;
        delete returns[state.watching];
    }
    if (next !== undefined) {
        const boundary = leftAt[next];
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

export function setWatchedSession(sessionId: string | undefined, now = Date.now()): void {
    useSessionLookStore.setState((state) => advanceSessionLook(state, sessionId, now));
}

export function dismissReturn(sessionId: string): void {
    useSessionLookStore.setState((state) => dismissSessionReturn(state, sessionId));
}
