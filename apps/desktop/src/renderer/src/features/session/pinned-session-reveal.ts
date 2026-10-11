import { createStore } from '../../lib/store';

interface PinnedSessionRevealState {
    /**
     * The live-region sentence for the last revealed pin (`Pinned <title>`). Kept here rather than in component state
     * so consuming a request is one store update, not a state change cascading out of an effect.
     */
    announcement: string;
    /**
     * The Session just pinned, with a revision so pinning the same Session twice is still two requests.
     */
    request?: { id: number; sessionId: string };
}

/**
 * Hands a successful pin to the Primary Side Bar, which owns the Pinned group's window and live region. A newly pinned
 * Session lands at the end of the Pinned order and so can fall below the group's five-row window; the sidebar reveals
 * it and announces it, the way `Alt+Arrow` reports a move. A store rather than a callback because the pin request runs
 * outside React (the row's hover button, its context menu).
 */
export const usePinnedSessionRevealStore = createStore<PinnedSessionRevealState>(
    'pinnedSessionReveal',
    () => ({ announcement: '' }),
);

export function requestPinnedSessionReveal(sessionId: string): void {
    usePinnedSessionRevealStore.setState((state) => ({
        request: { id: (state.request?.id ?? 0) + 1, sessionId },
    }));
}

/**
 * Consumes the pending request once the sidebar revealed its row, and records what the live region announces.
 */
export function settlePinnedSessionReveal(announcement: string): void {
    usePinnedSessionRevealStore.setState({ announcement, request: undefined });
}
