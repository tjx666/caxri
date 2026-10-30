import type { AgentProvider } from '@caxri/protocol';

import { createStore } from '../lib/store';

export type SettingsView =
    | 'ui'
    | 'source'
    | 'keybindings'
    | 'trusted-domains'
    | 'agent-actions'
    | 'agent-executable'
    | 'hardware-acceleration'
    | 'remote-debugging'
    | 'notifications'
    | 'git-exclusions'
    | 'agent-suspension'
    | 'claude-windows';

/**
 * Which control the open Session-creation menu belongs under. The Project heading's New Session button and the
 * empty-Project row's own New Session button are separate anchors for the same menu, and both can render a trigger for
 * one Project at once.
 */
export type CreateSessionAnchor = 'heading' | 'emptyProject';

/**
 * A status-bar chip whose popover can also be opened from a command. Both chips hang off the Session the status bar
 * already describes, so the request names only the picker; the chip resolves its own Session and repository.
 */
export type StatusBarPicker = 'branch' | 'workbenchRoot';

/**
 * Fields an opener writes into the Project search draft. An omitted field keeps whatever the user last left there.
 */
interface ProjectSearchSeed {
    include?: string;
    query?: string;
}

interface DialogState {
    archivedSessionsOpen: boolean;
    settingsRequest: { id: number; view: SettingsView; provider?: AgentProvider };
    /**
     * The latest global Workbench page request. Before a Session exists, `NoSessionSurface` renders this page in place
     * of Welcome; with a Session, each page's opener turns the same request into an ordinary document tab.
     */
    workbenchPageRequest: { id: number; surface: 'environment' | 'settings' };
    /**
     * The last global Workbench page request the user closed from the Welcome view.
     */
    sessionlessWorkbenchPageDismissedId: number;
    paletteOpen: boolean;
    projectSearchOpen: boolean;
    /**
     * The latest seed for the Project search draft, carried as a bumped revision so opening twice with the same seed
     * still re-applies it over whatever the user typed in between. The draft is local state of the always-mounted
     * dialog shell, and this is the channel an opener reaches it through.
     */
    projectSearchSeedRequest: { id: number; seed: ProjectSearchSeed };
    sessionSearchOpen: boolean;
    keyboardShortcutsOpen: boolean;
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
     * When {@link DialogState.pendingRoot} was granted, so a resume can tell that Main's single-use folder grant (60
     * seconds) has lapsed before the user is walked back into a dialog whose choice would fail with `PATH_DENIED`.
     */
    pendingRootGrantedAt?: number;
    /**
     * True while the user is in Settings configuring an Agent for the pending creation: the Agent dialog is hidden but
     * the pending Project (or folder grant) is kept, and a banner offers Resume or Cancel.
     */
    isPendingSuspended: boolean;
    /**
     * The open Session-creation menu, named by its Project _and_ the trigger it hangs from rather than by a boolean.
     * Both halves are load-bearing: the menu must appear under the control the user actually clicked, and a Project
     * with no Sessions renders a second New Session button below its heading, so a Project id alone would let both rows
     * claim the same menu and stack two popups over one choice. Kept in the store rather than in the row so the
     * `session.create` command opens the same menu the pointer does, instead of a second, centered picker.
     */
    createSessionMenu?: {
        anchor: CreateSessionAnchor;
        projectId: string;
    };
    /**
     * A pending request to rename one Session, carried as a bumped revision rather than a boolean so asking twice for
     * the same Session still re-opens the editor. Renaming is local React state inside the Primary Side Bar's row, and
     * a command has no way to reach it; this is the channel between the two. The row clears it as soon as it has opened
     * the editor: the Primary Side Bar unmounts whenever it is hidden, so an answered request left standing here would
     * re-open the editor by itself the next time the side bar came back.
     */
    renameSessionRequest?: {
        id: number;
        sessionId: string;
        /**
         * Opens the editor and asks for an AI-generated name, as the row's `Shift+Enter` does.
         */
        suggest?: boolean;
    };
    /**
     * A pending request to open one status-bar picker. Same revision contract as {@link DialogState.settingsRequest}:
     * the chip owns its popover's open state, and the command only asks.
     */
    statusBarPickerRequest?: { id: number; picker: StatusBarPicker };
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
    /**
     * Bumps {@link DialogState.settingsRequest}. The Settings surface is an ordinary Workbench document tab, opened
     * through `openEditorTab` by the request listener in `app.tsx`, not tracked here as an open/closed boolean.
     */
    openSettings(view?: SettingsView, provider?: AgentProvider): void;
    openEnvironment(): void;
    dismissSessionlessWorkbenchPage(): void;
    setPaletteOpen(isOpen: boolean): void;
    setProjectSearchOpen(isOpen: boolean): void;
    openProjectSearch(seed?: ProjectSearchSeed): void;
    setSessionSearchOpen(isOpen: boolean): void;
    setKeyboardShortcutsOpen(isOpen: boolean): void;
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
    suspendPending(): void;
    resumePending(): void;
    openCreateSessionMenu(projectId: string, anchor: CreateSessionAnchor): void;
    requestSessionRename(sessionId: string, options?: { suggest?: boolean }): void;
    clearSessionRenameRequest(): void;
    openStatusBarPicker(picker: StatusBarPicker): void;
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

export const useDialogStore = createStore<DialogState>('dialogs', (set, get) => ({
    archivedSessionsOpen: false,
    settingsRequest: { id: 0, view: 'ui' },
    workbenchPageRequest: { id: 0, surface: 'settings' },
    sessionlessWorkbenchPageDismissedId: 0,
    paletteOpen: false,
    projectSearchOpen: false,
    projectSearchSeedRequest: { id: 0, seed: {} },
    sessionSearchOpen: false,
    keyboardShortcutsOpen: false,
    agentActionsOpen: false,
    agentActionsTerminalId: undefined,
    pathBrowserOpen: false,
    bugReportOpen: false,
    bugReportRequestId: 0,
    projectIconProjectId: undefined,
    pendingRoot: undefined,
    pendingProjectId: undefined,
    pendingRootGrantedAt: undefined,
    isPendingSuspended: false,
    createSessionMenu: undefined,
    renameSessionRequest: undefined,
    statusBarPickerRequest: undefined,
    openModalIds: new Set(),
    setArchivedSessionsOpen: (archivedSessionsOpen) => set({ archivedSessionsOpen }),
    openSettings: (view = 'ui', provider) =>
        set((state) => ({
            settingsRequest: { id: state.settingsRequest.id + 1, view, provider },
            workbenchPageRequest: {
                id: state.workbenchPageRequest.id + 1,
                surface: 'settings',
            },
        })),
    openEnvironment: () =>
        set((state) => ({
            workbenchPageRequest: {
                id: state.workbenchPageRequest.id + 1,
                surface: 'environment',
            },
        })),
    dismissSessionlessWorkbenchPage: () =>
        set((state) => ({
            sessionlessWorkbenchPageDismissedId: state.workbenchPageRequest.id,
        })),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    setProjectSearchOpen: (projectSearchOpen) => set({ projectSearchOpen }),
    openProjectSearch: (seed = {}) =>
        set((state) => ({
            projectSearchOpen: true,
            projectSearchSeedRequest: { id: state.projectSearchSeedRequest.id + 1, seed },
        })),
    setSessionSearchOpen: (sessionSearchOpen) => set({ sessionSearchOpen }),
    setKeyboardShortcutsOpen: (keyboardShortcutsOpen) => set({ keyboardShortcutsOpen }),
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
    askAgentForRoot: (rootPath) =>
        set({
            pendingRoot: rootPath,
            pendingRootGrantedAt: Date.now(),
            pendingProjectId: undefined,
            isPendingSuspended: false,
        }),
    askAgentForProject: (projectId) =>
        set({
            pendingProjectId: projectId,
            pendingRoot: undefined,
            pendingRootGrantedAt: undefined,
        }),
    clearPending: () =>
        set({
            pendingRoot: undefined,
            pendingProjectId: undefined,
            pendingRootGrantedAt: undefined,
            isPendingSuspended: false,
        }),
    suspendPending: () => set({ isPendingSuspended: true }),
    resumePending: () => set({ isPendingSuspended: false }),
    openCreateSessionMenu: (projectId, anchor) => set({ createSessionMenu: { anchor, projectId } }),
    closeCreateSessionMenu: () => set({ createSessionMenu: undefined }),
    requestSessionRename: (sessionId, options) =>
        set((state) => ({
            renameSessionRequest: {
                id: (state.renameSessionRequest?.id ?? 0) + 1,
                sessionId,
                ...(options?.suggest && { suggest: true }),
            },
        })),
    clearSessionRenameRequest: () => set({ renameSessionRequest: undefined }),
    openStatusBarPicker: (picker) =>
        set((state) => ({
            statusBarPickerRequest: { id: (state.statusBarPickerRequest?.id ?? 0) + 1, picker },
        })),
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

export const openSettings = (view: SettingsView = 'ui'): void =>
    useDialogStore.getState().openSettings(view);
export const setArchivedSessionsOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setArchivedSessionsOpen(isOpen);
export const setPaletteOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setPaletteOpen(isOpen);
export const setProjectSearchOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setProjectSearchOpen(isOpen);
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
export const requestSessionRename = (sessionId: string, options?: { suggest?: boolean }): void =>
    useDialogStore.getState().requestSessionRename(sessionId, options);

export const clearSessionRenameRequest = (): void =>
    useDialogStore.getState().clearSessionRenameRequest();
export const openStatusBarPicker = (picker: StatusBarPicker): void =>
    useDialogStore.getState().openStatusBarPicker(picker);

export const setSessionSearchOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setSessionSearchOpen(isOpen);
export const setKeyboardShortcutsOpen = (isOpen: boolean): void =>
    useDialogStore.getState().setKeyboardShortcutsOpen(isOpen);
