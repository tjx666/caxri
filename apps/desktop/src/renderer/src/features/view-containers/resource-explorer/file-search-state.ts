import { createStore } from '../../../lib/store';

interface FileSearchState {
    activeSessionId?: string;
    focusRevision: number;
    close(sessionId: string): void;
    focus(sessionId: string): void;
}

/**
 * Renderer-local source of truth shared by the command and the Session-scoped Resource Explorer surface.
 */
export const useFileSearchStore = createStore<FileSearchState>('file-search', (set) => ({
    activeSessionId: undefined,
    focusRevision: 0,
    close: (sessionId) =>
        set((state) =>
            state.activeSessionId === sessionId ? { activeSessionId: undefined } : state,
        ),
    focus: (sessionId) =>
        set((state) => ({
            activeSessionId: sessionId,
            focusRevision: state.focusRevision + 1,
        })),
}));

export function requestFileSearchFocus(sessionId: string): void {
    useFileSearchStore.getState().focus(sessionId);
}

export function closeFileSearch(sessionId: string): void {
    useFileSearchStore.getState().close(sessionId);
}
