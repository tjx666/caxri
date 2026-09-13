import type { AgentProvider } from '@caxri/protocol';
import { create } from 'zustand';

export type SettingsView =
    | 'ui'
    | 'source'
    | 'keybindings'
    | 'trusted-domains'
    | 'agent-actions'
    | 'hardware-acceleration'
    | 'notifications'
    | 'git-exclusions';

/**
 * Which control the open Session-creation menu belongs under. The Project heading's New Session button and the
 * empty-Project row's own New Session button are separate anchors for the same menu, and several rows of one Project
 * can render a trigger at once.
 */
export type CreateSessionAnchor = 'heading' | 'emptyProject';

interface DialogState {
    archivedSessionsOpen: boolean;
    settingsOpen: boolean;
    settingsRequest: { id: number; view: SettingsView; provider?: AgentProvider };
    paletteOpen: boolean;
    agentActionsOpen: boolean;
    agentActionsTerminalId?: string;
    pathBrowserOpen: boolean;
    bugReportOpen: boolean;
    bugReportRequestId: number;
    projectIconProjectId?: string;
    /**
     * Folder granted by the native picker, awaiting the default-Agent choice.
     */
    pendingRoot?: string;
    /**
     * Existing Project awaiting the default-Agent choice for a new Session.
     */
    pendingProjectId?: string;
    /**
     * The open Session-creation menu, named by its Project _and_ the trigger it hangs from rather than by a boolean.
     * Both halves are load-bearing: the menu must appear under the control the user actually clicked, and a Project
     * with no Sessions renders a second New Session button below its heading, so a Project id alone would let both rows
     * claim the same menu and stack two popups over one choice. Kept in the store rather than in the row so the
     * `session.create` command opens the same menu the pointer does, instead of a second, centered picker.
     */
    createSessionMenu?: { anchor: CreateSessionAnchor; projectId: string };
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
    openSettings(view?: SettingsView, provider?: AgentProvider): void;
    setSettingsOpen(isOpen: boolean): void;
    setPaletteOpen(isOpen: boolean): void;
    openAgentActions(terminalId: string): void;
    setAgentActionsOpen(isOpen: boolean): void;
    setPathBrowserOpen(isOpen: boolean): void;
    openBugReport(): void;
    setBugReportOpen(isOpen: boolean): void;
    openProjectIcon(projectId: string): void;
    closeProjectIcon(): void;
    askAgentForRoot(rootPath: string): void;
    askAgentForProject(projectId: string): void;
    clearPending(): void;
    openCreateSessionMenu(projectId: string, anchor: CreateSessionAnchor): void;
    closeCreateSessionMenu(): void;
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
    agentActionsOpen: false,
    agentActionsTerminalId: undefined,
    pathBrowserOpen: false,
    bugReportOpen: false,
    bugReportRequestId: 0,
    projectIconProjectId: undefined,
    pendingRoot: undefined,
    pendingProjectId: undefined,
    createSessionMenu: undefined,
    openModalIds: new Set(),
    setArchivedSessionsOpen: (archivedSessionsOpen) => set({ archivedSessionsOpen }),
    openSettings: (view = 'ui', provider) =>
        set((state) => ({
            settingsOpen: true,
            settingsRequest: { id: state.settingsRequest.id + 1, view, provider },
        })),
    setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    openAgentActions: (agentActionsTerminalId) =>
        set({ agentActionsOpen: true, agentActionsTerminalId }),
    setAgentActionsOpen: (agentActionsOpen) => set({ agentActionsOpen }),
    setPathBrowserOpen: (pathBrowserOpen) => set({ pathBrowserOpen }),
    openBugReport: () =>
        set((state) => ({
            bugReportOpen: true,
            bugReportRequestId: state.bugReportRequestId + 1,
        })),
    setBugReportOpen: (bugReportOpen) => set({ bugReportOpen }),
    openProjectIcon: (projectIconProjectId) => set({ projectIconProjectId }),
    closeProjectIcon: () => set({ projectIconProjectId: undefined }),
    askAgentForRoot: (rootPath) => set({ pendingRoot: rootPath, pendingProjectId: undefined }),
    askAgentForProject: (projectId) => set({ pendingProjectId: projectId, pendingRoot: undefined }),
    clearPending: () => set({ pendingRoot: undefined, pendingProjectId: undefined }),
    openCreateSessionMenu: (projectId, anchor) => set({ createSessionMenu: { anchor, projectId } }),
    closeCreateSessionMenu: () => set({ createSessionMenu: undefined }),
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
export const openSettings = (view: SettingsView = 'ui'): void =>
    useDialogStore.getState().openSettings(view);
export const setArchivedSessionsOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setArchivedSessionsOpen(isOpen);
export const setPaletteOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setPaletteOpen(isOpen);
export const setAgentActionsOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setAgentActionsOpen(isOpen);
export const setPathBrowserOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setPathBrowserOpen(isOpen);
export const setBugReportOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setBugReportOpen(isOpen);
export const closeProjectIconDialog = (): void => useDialogStore.getState().closeProjectIcon();
export const clearPendingSession = (): void => useDialogStore.getState().clearPending();
export const closeCreateSessionMenu = (): void =>
    useDialogStore.getState().closeCreateSessionMenu();
