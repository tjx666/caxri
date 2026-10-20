import { createStore } from '../../lib/store';

/**
 * How many Sessions keep a live Workbench at once, the selected one included.
 *
 * The ceiling is a memory budget. GPU contexts do not bound it: a retained Session only holds a WebGL context while it
 * is on screen (`TerminalRendererController.suspend` releases the rest), so the live contexts follow the visible
 * Session's splits whatever this is. A hidden Session is skipped by style, layout, and paint (`content-visibility:
 * hidden`) and a hidden Chat stops following its stream (`agentChatReadFollowOptions`), but each one still keeps its
 * DOM, xterm buffers, and editor models, and a hidden Terminal still parses its PTY output. A sixteen-turn
 * Markdown-heavy Chat measured about 6 MB of heap and 4,300 DOM nodes, while switching back to it mounted took about 27
 * ms instead of 65 ms for a remount (`docs/renderer-performance.md`). Five covers the usual back and forth across a
 * handful of Sessions; each Session beyond that buys less and keeps one more hidden Terminal parsing.
 */
export const SESSION_KEEP_ALIVE_LIMIT = 5;

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
