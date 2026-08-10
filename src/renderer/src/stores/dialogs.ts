import { create } from 'zustand';

interface DialogState {
    settingsOpen: boolean;
    paletteOpen: boolean;
    pathBrowserOpen: boolean;
    /** Directory granted by the native picker, awaiting the default-Agent choice. */
    pendingRoot?: string;
    /** Existing Project awaiting the default-Agent choice for a new Session. */
    pendingProjectId?: string;
    /**
     * IDs of currently mounted-and-open modals, registered by `useModalRegistration`
     * (see `components/ui/dialog.tsx`) from every consumer of the shared `Dialog`
     * primitive. `isModalOpen` used to be a hand-maintained OR of one boolean per
     * dialog (settingsOpen, paletteOpen, pathBrowserOpen, pendingRoot, pendingProjectId); a future
     * modal that forgot to add its field there would silently let app-wide shortcuts
     * fire behind it. Registration is mount/open driven instead, so any dialog built
     * on the shared primitive participates automatically and cannot drift out of sync.
     * A `Set` (rather than a counter) keeps re-registration under React StrictMode's
     * double-invoked effects idempotent.
     */
    openModalIds: Set<string>;
    setSettingsOpen(open: boolean): void;
    setPaletteOpen(open: boolean): void;
    setPathBrowserOpen(open: boolean): void;
    askAgentForRoot(rootPath: string): void;
    askAgentForProject(projectId: string): void;
    clearPending(): void;
    /** Registers an open modal's id; called by `useModalRegistration` on open/mount. */
    registerModal(id: string): void;
    /** Unregisters a modal's id; called by `useModalRegistration` on close/unmount. */
    unregisterModal(id: string): void;
    /** True while any modal owns the keyboard, so app-wide shortcuts must stand down. */
    isModalOpen(): boolean;
}

export const useDialogStore = create<DialogState>((set, get) => ({
    settingsOpen: false,
    paletteOpen: false,
    pathBrowserOpen: false,
    pendingRoot: undefined,
    pendingProjectId: undefined,
    openModalIds: new Set(),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setPathBrowserOpen: (pathBrowserOpen) => set({ pathBrowserOpen }),
    askAgentForRoot: (rootPath) => set({ pendingRoot: rootPath, pendingProjectId: undefined }),
    askAgentForProject: (projectId) => set({ pendingProjectId: projectId, pendingRoot: undefined }),
    clearPending: () => set({ pendingRoot: undefined, pendingProjectId: undefined }),
    registerModal: (id) =>
        set((state) => {
            if (state.openModalIds.has(id)) return state;
            const openModalIds = new Set(state.openModalIds);
            openModalIds.add(id);
            return { openModalIds };
        }),
    unregisterModal: (id) =>
        set((state) => {
            if (!state.openModalIds.has(id)) return state;
            const openModalIds = new Set(state.openModalIds);
            openModalIds.delete(id);
            return { openModalIds };
        }),
    isModalOpen() {
        return get().openModalIds.size > 0;
    },
}));

export const setSettingsOpen = (open: boolean): void =>
    useDialogStore.getState().setSettingsOpen(open);
export const setPaletteOpen = (open: boolean): void =>
    useDialogStore.getState().setPaletteOpen(open);
export const setPathBrowserOpen = (open: boolean): void =>
    useDialogStore.getState().setPathBrowserOpen(open);
export const clearPendingSession = (): void => useDialogStore.getState().clearPending();
