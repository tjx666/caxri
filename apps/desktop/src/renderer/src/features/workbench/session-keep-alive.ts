import { createStore } from '../../lib/store';

/**
 * How many Sessions keep a live Workbench at once, the selected one included.
 *
 * The ceiling is a GPU budget, not a memory guess. Chromium allows a page roughly 16 live WebGL contexts and
 * force-loses the oldest beyond that, which `../gpu/gpu-incident-budget.ts` banks as a real incident and eventually
 * uses to pin every Terminal to the DOM renderer. A retained Session only holds a context while it is on screen
 * (`TerminalRendererController.suspend` releases the rest), so three is a deliberately conservative bound that leaves
 * the visible Session's splits room to grow without the retained ones competing for contexts at all.
 */
export const SESSION_KEEP_ALIVE_LIMIT = 3;

interface SessionKeepAliveState {
    /**
     * Most recently selected first. The head is the Session currently on screen.
     */
    retained: readonly string[];
}

export const useSessionKeepAliveStore = createStore<SessionKeepAliveState>(
    'sessionKeepAlive',
    () => ({
        retained: [],
    }),
);

function nextRetained(current: readonly string[], sessionId: string): readonly string[] {
    if (current[0] === sessionId) return current;
    return [sessionId, ...current.filter((id) => id !== sessionId)].slice(
        0,
        SESSION_KEEP_ALIVE_LIMIT,
    );
}

/**
 * Promotes the Session the user just selected to the head of the keep-alive list, evicting the least recently used one
 * past the limit. Returning the identical array when nothing moved is what keeps a re-selection of the already visible
 * Session from re-rendering every retained Workbench.
 */
export function retainKeepAliveSession(sessionId: string | undefined): void {
    if (!sessionId) return;
    useSessionKeepAliveStore.setState((state) => {
        const retained = nextRetained(state.retained, sessionId);
        return retained === state.retained ? state : { retained };
    });
}

/**
 * Drops Sessions that no longer exist. Archiving or deleting a Session must release its kept-alive Workbench, and with
 * it every xterm, PTY subscription, and Editor model that pane still holds, rather than leaving it mounted against a
 * Session the Server has forgotten.
 */
export function pruneKeepAliveSessions(liveSessionIds: ReadonlySet<string>): void {
    useSessionKeepAliveStore.setState((state) => {
        const retained = state.retained.filter((id) => liveSessionIds.has(id));
        return retained.length === state.retained.length ? state : { retained };
    });
}
