import { createStore } from '../../../lib/store';

export interface FileClipboardEntry {
    mode: 'copy' | 'cut';
    path: string;
    /**
     * The Session the item was cut or copied in. Server Core authorizes `path` against that Session's root, so a paste
     * can land in any Project.
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
