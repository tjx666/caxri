import { createStore } from '../../lib/store';
import { useChromeLayoutStore } from '../../stores/chrome-layout';

interface SessionRevealState {
    /**
     * The Session whose sidebar row should be shown, with a revision so asking twice for the same Session still scrolls
     * the second time.
     */
    request?: { id: number; sessionId: string };
}

/**
 * Hands "Reveal in Sidebar" to the Primary Side Bar, which owns the Project collapse state and the row scroll. A store
 * rather than a callback because the tab's context menu runs outside React. Same revision contract as
 * `usePinnedSessionRevealStore`.
 */
export const useSessionRevealStore = createStore<SessionRevealState>('sessionReveal', () => ({}));

/**
 * Shows the Session's sidebar row: a hidden Primary Side Bar is opened and the Activity view (which has no Project
 * tree) is switched back to the Project tree first, then the tree expands the Session's Project and scrolls the row.
 */
export function revealSessionInSidebar(sessionId: string): void {
    const layout = useChromeLayoutStore.getState();
    if (!layout.primarySidebarVisible) layout.setPrimarySidebarVisible(true);
    if (layout.primarySidebarActivityMode) layout.togglePrimarySidebarActivityMode();
    useSessionRevealStore.setState((state) => ({
        request: { id: (state.request?.id ?? 0) + 1, sessionId },
    }));
}

/**
 * Consumes the pending request once the sidebar has acted on it.
 */
export function settleSessionReveal(): void {
    useSessionRevealStore.setState({ request: undefined });
}
