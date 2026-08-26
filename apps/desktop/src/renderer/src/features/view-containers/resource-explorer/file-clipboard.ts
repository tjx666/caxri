import { create } from 'zustand';

export interface FileClipboardEntry {
    mode: 'copy' | 'cut';
    path: string;
    projectId: string;
}

interface FileClipboardState {
    entry?: FileClipboardEntry;
    clear(): void;
    set(entry: FileClipboardEntry): void;
}

/**
 * Application-local clipboard; filesystem authority is rechecked by Server on every paste.
 */
export const useFileClipboardStore = create<FileClipboardState>((set) => ({
    clear: () => set({ entry: undefined }),
    set: (entry) => set({ entry }),
}));
