import { createStore } from '../../../lib/store';

export interface FileClipboardEntry {
    mode: 'copy' | 'cut';
    /**
     * Every entry cut or copied together (one row, or a multi-selection without entries nested in another of them).
     */
    paths: readonly string[];
    /**
     * The Session the items were cut or copied in. Server Core authorizes `paths` against that Session's root, so a
     * paste can land in any Project.
     */
    sessionId: string;
}

interface FileClipboardState {
    entry?: FileClipboardEntry;
    clear(): void;
    set(entry: FileClipboardEntry): void;
}

/**
 * Application-local clipboard; filesystem authority is rechecked by Server on every paste.
 */
export const useFileClipboardStore = createStore<FileClipboardState>('file-clipboard', (set) => ({
    clear: () => set({ entry: undefined }),
    set: (entry) => set({ entry }),
}));
