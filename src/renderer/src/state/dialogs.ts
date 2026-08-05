import { create } from 'zustand';

interface DialogState {
    settingsOpen: boolean;
    paletteOpen: boolean;
    /** Directory granted by the native picker, awaiting the default-Agent choice. */
    pendingRoot?: string;
    /** Existing Project awaiting the default-Agent choice for a new Session. */
    pendingProjectId?: string;
    setSettingsOpen(open: boolean): void;
    setPaletteOpen(open: boolean): void;
    askAgentForRoot(rootPath: string): void;
    askAgentForProject(projectId: string): void;
    clearPending(): void;
    /** True while any modal owns the keyboard, so app-wide shortcuts must stand down. */
    isModalOpen(): boolean;
}

export const useDialogStore = create<DialogState>((set, get) => ({
    settingsOpen: false,
    paletteOpen: false,
    pendingRoot: undefined,
    pendingProjectId: undefined,
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    askAgentForRoot: (rootPath) => set({ pendingRoot: rootPath, pendingProjectId: undefined }),
    askAgentForProject: (projectId) => set({ pendingProjectId: projectId, pendingRoot: undefined }),
    clearPending: () => set({ pendingRoot: undefined, pendingProjectId: undefined }),
    isModalOpen() {
        const { settingsOpen, paletteOpen, pendingRoot, pendingProjectId } = get();
        return Boolean(settingsOpen || paletteOpen || pendingRoot || pendingProjectId);
    },
}));

export const setSettingsOpen = (open: boolean): void =>
    useDialogStore.getState().setSettingsOpen(open);
export const setPaletteOpen = (open: boolean): void =>
    useDialogStore.getState().setPaletteOpen(open);
export const clearPendingSession = (): void => useDialogStore.getState().clearPending();
