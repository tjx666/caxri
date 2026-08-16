import { create } from 'zustand';

export type SettingsView = 'ui' | 'source' | 'keybindings' | 'trusted-domains';

interface DialogState {
    archivedSessionsOpen: boolean;
    settingsOpen: boolean;
    settingsRequest: { id: number; view: SettingsView };
    paletteOpen: boolean;
    pathBrowserOpen: boolean;
    bugReportOpen: boolean;
    bugReportRequestId: number;
    /**
     * Directory granted by the native picker, awaiting the default-Agent choice.
     */
    pendingRoot?: string;
    /**
     * Existing Project awaiting the default-Agent choice for a new Session.
     */
    pendingProjectId?: string;
    /**
     * IDs of currently mounted-and-open modals, registered by `useModalRegistration` (see `components/ui/dialog.tsx`)
     * from every consumer of the shared `Dialog` primitive. `isModalOpen` used to be a hand-maintained OR of one
     * boolean per dialog (settingsOpen, paletteOpen, pathBrowserOpen, pendingRoot, pendingProjectId); a future modal
     * that forgot to add its field there would silently let app-wide shortcuts fire behind it. Registration is
     * mount/open driven instead, so any dialog built on the shared primitive participates automatically and cannot
     * drift out of sync. A `Set` (rather than a counter) keeps re-registration under React StrictMode's double-invoked
     * effects idempotent.
     */
    openModalIds: Set<string>;
    setArchivedSessionsOpen(isOpen: boolean): void;
    openSettings(view?: SettingsView): void;
    setSettingsOpen(isOpen: boolean): void;
    setPaletteOpen(isOpen: boolean): void;
    setPathBrowserOpen(isOpen: boolean): void;
    openBugReport(): void;
    setBugReportOpen(isOpen: boolean): void;
    askAgentForRoot(rootPath: string): void;
    askAgentForProject(projectId: string): void;
    clearPending(): void;
    /**
     * Registers an open modal's id; called by `useModalRegistration` on open/mount.
     */
    registerModal(id: string): void;
    /**
     * Unregisters a modal's id; called by `useModalRegistration` on close/unmount.
     */
    unregisterModal(id: string): void;
    /**
     * True while any modal owns the keyboard, so app-wide shortcuts must stand down.
     */
    isModalOpen(): boolean;
}

export const useDialogStore = create<DialogState>((set, get) => ({
    archivedSessionsOpen: false,
    settingsOpen: false,
    settingsRequest: { id: 0, view: 'ui' },
    paletteOpen: false,
    pathBrowserOpen: false,
    bugReportOpen: false,
    bugReportRequestId: 0,
    pendingRoot: undefined,
    pendingProjectId: undefined,
    openModalIds: new Set(),
    setArchivedSessionsOpen: (archivedSessionsOpen) => set({ archivedSessionsOpen }),
    openSettings: (view = 'ui') =>
        set((state) => ({
            settingsOpen: true,
            settingsRequest: { id: state.settingsRequest.id + 1, view },
        })),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setPathBrowserOpen: (pathBrowserOpen) => set({ pathBrowserOpen }),
    openBugReport: () =>
        set((state) => ({
            bugReportOpen: true,
            bugReportRequestId: state.bugReportRequestId + 1,
        })),
    setBugReportOpen: (bugReportOpen) => set({ bugReportOpen }),
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

export const setSettingsOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setSettingsOpen(isOpen);
export const setArchivedSessionsOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setArchivedSessionsOpen(isOpen);
export const setPaletteOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setPaletteOpen(isOpen);
export const setPathBrowserOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setPathBrowserOpen(isOpen);
export const setBugReportOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setBugReportOpen(isOpen);
export const clearPendingSession = (): void => useDialogStore.getState().clearPending();
