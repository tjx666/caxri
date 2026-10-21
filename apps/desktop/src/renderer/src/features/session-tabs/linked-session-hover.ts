import { createStore } from '../../lib/store';

interface LinkedSessionHoverState {
    /**
     * The Session whose tab or sidebar row the pointer is over, or `undefined` when it is over neither.
     */
    sessionId?: string;
}

/**
 * Links the two places a Session appears, its Open Session tab and its sidebar row: hovering one softly highlights the
 * other. A store rather than props because the tab strip and the sidebar are unrelated subtrees. Every consumer selects
 * a boolean for its own Session (`useIsLinkedSessionHovered`), so moving the pointer re-renders the two rows that
 * changed, never every row or tab.
 */
export const useLinkedSessionHoverStore = createStore<LinkedSessionHoverState>(
    'linkedSessionHover',
    () => ({}),
);

export function setLinkedHoveredSession(sessionId: string | undefined): void {
    if (useLinkedSessionHoverStore.getState().sessionId === sessionId) return;
    useLinkedSessionHoverStore.setState({ sessionId });
}

/**
 * Ends the hover only if it still belongs to `sessionId`, so a late pointer-leave from one element cannot clear the
 * hover that the next element already took over.
 */
export function clearLinkedHoveredSession(sessionId: string): void {
    if (useLinkedSessionHoverStore.getState().sessionId === sessionId)
        useLinkedSessionHoverStore.setState({ sessionId: undefined });
}

export function useIsLinkedSessionHovered(sessionId: string): boolean {
    return useLinkedSessionHoverStore((state) => state.sessionId === sessionId);
}
