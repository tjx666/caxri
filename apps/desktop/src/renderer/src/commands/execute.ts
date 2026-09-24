import './definitions';

import type { CommandId } from '@caxri/protocol';
import { errorMessage, listPaneTerminalIds, paneSplitBlockedReason } from '@caxri/protocol';

import { focusNextAttentionSession } from '../features/agent-activity/agent-activity-commands';
import { closeDocumentTabs, saveActiveEditor } from '../features/editor/document-commands';
import {
    canOpenImportLinkAtCursor,
    openImportLinkAtCursor,
} from '../features/editor/import-link-commands';
import {
    canSendActiveFileReference,
    sendActiveFileReferenceToTerminal,
} from '../features/editor/send-file-reference';
import {
    canOpenActivePreview,
    openActiveFilePreview,
    openActiveFilePreviewToSide,
} from '../features/preview/preview-commands';
import { focusPrimarySidebar } from '../features/primary-sidebar/primary-sidebar-focus';
import { toggleScreencastMode } from '../features/screencast/screencast';
import { deleteProject, hideSelectedProject } from '../features/session/project-removal-commands';
import {
    archiveSelectedSession,
    archiveSession,
    beginSessionCreation,
    canNavigateSessionHistory,
    chooseProjectFolder,
    deleteSelectedSession,
    detachSelectedSession,
    moveTerminalToNewSession,
    navigateSessionHistory,
    openArchivedSessions,
    openSelectedProjectInExternalEditor,
    openSelectedSessionPullRequest,
    renameSelectedSession,
    resumeSelectedSession,
    selectAdjacentSession,
    switchMruSession,
} from '../features/session/session-commands';
import { lastTabTerminalSessionId } from '../features/session/session-last-tab';
import {
    canSelectWorkbenchRoot,
    canSwitchBranch,
    selectWorkbenchRootFromCommand,
    switchBranchFromCommand,
} from '../features/status-bar/status-bar-picker-commands';
import { cycleActiveTab } from '../features/tabs/tab-navigation';
import {
    clearActiveTerminal,
    closeTerminal,
    copyActiveTerminalSelection,
    createDefaultTerminal,
    findInActiveTerminal,
    hasActiveTerminalSelection,
    navigateActiveTerminalCommand,
    restartActiveTerminal,
    sendTerminalSequence,
    startNewAgentSession,
} from '../features/terminal/terminal-commands';
import { openTerminalLinkPicker } from '../features/terminal/terminal-link-actions';
import { checkForUpdates } from '../features/updates/update-commands';
import {
    executeEditableViewCatalogShortcut,
    executeViewCatalogShortcut,
    getCachedViewCatalogCommandAllowedInEditable,
} from '../features/view-containers/view-container-commands';
import {
    canFocusPaneInDirection,
    focusPaneInDirection,
    getActivePaneId,
    getActivePaneTab,
    getPaneLayout,
    splitPaneTab,
} from '../features/workbench/pane-actions';
import { caxri } from '../lib/caxri';
import { isEditableEventTarget } from '../lib/keybindings';
import { isAgentProcessRunning } from '../lib/terminal-agent-runtime';
import { useChromeLayoutStore } from '../stores/chrome-layout';
import { useDialogStore } from '../stores/dialogs';
import { getBootstrap, getSelectedSession, selectSelectedProject } from '../stores/selectors';
import { useSessionViewStore } from '../stores/session-view';
import { pushToast, tryCommand } from '../stores/toasts';
import type { CommandContext } from './registry';
import { getRegisteredCommand } from './registry';

export type { CommandContext } from './registry';

function activeTerminalId(): string | undefined {
    const resource = getActivePaneTab()?.resource;
    return resource?.kind === 'terminal' ? resource.terminalId : undefined;
}

function activeAgentTerminal() {
    const terminalId = activeTerminalId();
    if (!terminalId) return;
    const terminal = getBootstrap()?.terminals.find((candidate) => candidate.id === terminalId);
    return terminal?.provider && isAgentProcessRunning(terminal.lastAgentProcessState)
        ? terminal
        : undefined;
}

/**
 * The active pane's tab together with the pane holding it — the target of every command that splits or closes "the
 * current tab", whatever kind it holds.
 */
function activePaneTarget(): { paneId: string; tabId: string } | undefined {
    const paneId = getActivePaneId();
    const tab = getActivePaneTab();
    return paneId && tab ? { paneId, tabId: tab.id } : undefined;
}

/**
 * Makes a Secondary Side Bar ViewContainer reachable before persisting it into the selected Session.
 */
function activateSecondarySidebarViewContainer(
    id: Parameters<CommandContext['secondarySidebar']['activateViewContainer']>[0],
): void {
    if (!useChromeLayoutStore.getState().secondarySidebarVisible)
        useChromeLayoutStore.getState().setSecondarySidebarVisible(true);
    useSessionViewStore.getState().setDesiredSecondarySidebarViewContainerId(id);
}

/**
 * `terminal.copy` binds `Cmd+C`, the single most overloaded chord in the app, and is `allowInEditable` so it can reach
 * through the xterm surface. Availability therefore cannot rest on "the active tab is a terminal with a selection"
 * alone: a primarySidebar rename field or the path browser input can hold focus while a stale terminal selection is
 * still highlighted behind them, and hijacking their `Cmd+C` would silently copy the wrong text. Requiring focus to
 * actually sit inside the terminal keeps the chord falling through to the native copy everywhere else.
 */
function isTerminalSurfaceFocused(): boolean {
    const focused = document.activeElement;
    return focused instanceof Element && focused.closest('.xterm') !== null;
}

// Command handlers below are fire-and-forget by design: each async action already funnels its
// own failures into a toast via `tryCommand` (or an equivalent internal try/catch), and the
// registry's `run(context, arguments_)` contract (see `./registry`) is synchronous, so none of
// these can be awaited by their caller anyway.
const commandContext: CommandContext = {
    agentActions: {
        canOpen: () => Boolean(activeAgentTerminal()),
        open: () => {
            const terminal = activeAgentTerminal();
            if (terminal) useDialogStore.getState().openAgentActions(terminal.id);
        },
    },
    project: {
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        create: () => void chooseProjectFolder(),
        customizeIcon: (projectId) => {
            const target =
                getBootstrap()?.projects.find((project) => project.id === projectId) ??
                selectSelectedProject(getBootstrap());
            if (target) useDialogStore.getState().openProjectIcon(target.id);
        },
        openInExternalEditor: openSelectedProjectInExternalEditor,
        hideSelected: hideSelectedProject,
        remove: deleteProject,
    },
    session: {
        create: () => {
            const project = selectSelectedProject(getBootstrap());
            if (project) beginSessionCreation(project.id);
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            else void chooseProjectFolder();
        },
        archiveSelected: archiveSelectedSession,
        canNavigateHistory: canNavigateSessionHistory,
        deleteSelected: deleteSelectedSession,
        detachSelected: detachSelectedSession,
        focusNextAttention: focusNextAttentionSession,
        navigateHistory: navigateSessionHistory,
        openArchived: openArchivedSessions,
        openPullRequestSelected: openSelectedSessionPullRequest,
        renameSelected: renameSelectedSession,
        resumeSelected: resumeSelectedSession,
        selectAdjacent: selectAdjacentSession,
        switchMru: switchMruSession,
    },
    terminal: {
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        create: () => void createDefaultTerminal(),
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        createInSplit: () => void createDefaultTerminal({ split: 'right' }),
        clearActive: () => {
            const terminalId = activeTerminalId();
            if (terminalId) clearActiveTerminal(terminalId);
        },
        copySelection: () => {
            const terminalId = activeTerminalId();
            if (terminalId) copyActiveTerminalSelection(terminalId);
        },
        findActive: () => {
            const terminalId = activeTerminalId();
            if (terminalId) findInActiveTerminal(terminalId);
        },
        openDetectedLink: () => {
            const terminalId = activeTerminalId();
            if (terminalId) openTerminalLinkPicker(terminalId);
        },
        hasActive: () => Boolean(activeTerminalId()),
        hasSelection: () => {
            const terminalId = activeTerminalId();
            if (!terminalId || !isTerminalSurfaceFocused()) return false;
            return hasActiveTerminalSelection(terminalId);
        },
        navigateCommand: (direction) => {
            const terminalId = activeTerminalId();
            if (terminalId)
                navigateActiveTerminalCommand(terminalId, direction === -1 ? 'previous' : 'next');
        },
        sendSequence: (text) => {
            const terminalId = activeTerminalId();
            if (terminalId) sendTerminalSequence(terminalId, text);
        },
        restartActive: () => {
            const terminalId = activeTerminalId();
            if (terminalId) restartActiveTerminal(terminalId);
        },
        startNewAgentSession: () => {
            const terminalId = activeTerminalId();
            if (terminalId) startNewAgentSession(terminalId);
        },
        closeActive: () => {
            const terminalId = activeTerminalId();
            if (terminalId) closeTerminal(terminalId);
        },
    },
    workbench: {
        closeActiveTab: () => {
            const tab = getActivePaneTab();
            if (tab?.resource.kind === 'terminal') {
                const { terminalId } = tab.resource;
                const sessionId = lastTabTerminalSessionId(
                    getBootstrap()?.terminals ?? [],
                    getPaneLayout(),
                    terminalId,
                );
                if (sessionId) archiveSession(sessionId);
                else closeTerminal(terminalId);
            }
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            else if (tab) void closeDocumentTabs([tab.id]);
        },
        cycleTab: cycleActiveTab,
        /**
         * Splitting is a pane operation, so it is offered for a Terminal tab exactly as it is for a document: the two
         * differ only in what the new pane renders.
         */
        canSplitActive: () => {
            const layout = getPaneLayout();
            const target = activePaneTarget();
            if (!layout || !target) return false;
            // The same predicate the Context Menu and the reducer use, so a Split offered from the Command Palette or
            // the native menu cannot claim to be available where the write path would silently no-op.
            return paneSplitBlockedReason(layout, target.tabId, target.paneId) === undefined;
        },
        splitActive: (direction) => {
            const target = activePaneTarget();
            if (target) splitPaneTab(target.tabId, target.paneId, direction);
        },
        canFocusPaneInDirection,
        focusPaneInDirection,
        /**
         * Mirrors the tab context menu's own disabled reason (`pane-tab-bar.tsx`'s `isOnlySessionTerminal`): moving a
         * Session's last Terminal into a new Session would leave the old one with nothing in it.
         */
        canMoveActiveTerminalToNewSession: () => {
            const layout = getPaneLayout();
            const tab = getActivePaneTab();
            if (!layout || tab?.resource.kind !== 'terminal') return false;
            return listPaneTerminalIds(layout).length > 1;
        },
        moveActiveTerminalToNewSession: () => {
            const tab = getActivePaneTab();
            if (tab?.resource.kind !== 'terminal') return;
            const layout = getPaneLayout();
            const isOnlySessionTerminal = !layout || listPaneTerminalIds(layout).length <= 1;
            moveTerminalToNewSession(tab.resource.terminalId, isOnlySessionTerminal);
        },
        canSelectRoot: canSelectWorkbenchRoot,
        selectRoot: selectWorkbenchRootFromCommand,
    },
    editor: {
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        saveActive: () => void saveActiveEditor(),
        canSendReferenceToTerminal: canSendActiveFileReference,
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        sendReferenceToTerminal: () => void sendActiveFileReferenceToTerminal(),
        canOpenPreview: canOpenActivePreview,
        openPreview: openActiveFilePreview,
        openPreviewToSide: openActiveFilePreviewToSide,
        canOpenImportLink: canOpenImportLinkAtCursor,
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        openImportLink: () => void openImportLinkAtCursor(),
    },
    secondarySidebar: {
        activateViewContainer: activateSecondarySidebarViewContainer,
        toggle: () => useChromeLayoutStore.getState().toggleSecondarySidebar(),
    },
    panel: {
        activateViewContainer: (id) =>
            useChromeLayoutStore.getState().activatePanelViewContainer(id),
        toggle: () => useChromeLayoutStore.getState().togglePanel(),
    },
    primarySidebar: {
        focus: focusPrimarySidebar,
        toggle: () => useChromeLayoutStore.getState().togglePrimarySidebar(),
        toggleActivityMode: () =>
            useChromeLayoutStore.getState().togglePrimarySidebarActivityMode(),
    },
    git: { canSwitchBranch, switchBranch: switchBranchFromCommand },
    dialogs: {
        openSettings: (view = 'ui') => useDialogStore.getState().openSettings(view),
        openPalette: () => useDialogStore.getState().setPaletteOpen(true),
        openSessionContentSearch: () => useDialogStore.getState().setSessionContentSearchOpen(true),
        openProjectSearch: () => useDialogStore.getState().setProjectSearchOpen(true),
        openPathBrowser: () => {
            const bootstrap = getBootstrap();
            if (getSelectedSession() && selectSelectedProject(bootstrap))
                useDialogStore.getState().setPathBrowserOpen(true);
        },
    },
    windows: {
        openProcessExplorer: () => {
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void tryCommand('Unable to open Process Explorer', () =>
                caxri.request('processExplorer.open'),
            );
        },
    },
    developer: {
        reportBug: () => useDialogStore.getState().openBugReport(),
        toggleScreencastMode,
    },
    diagnostics: {
        export: () => {
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void tryCommand(
                'Diagnostics export failed',
                async () => {
                    const result = await caxri.request('diagnostics.export');
                    if (result) pushToast('success', `Diagnostics exported to ${result.path}`);
                },
                {
                    recovery: (error) => ({
                        id: 'diagnostics.copyFailure',
                        params: {
                            text: errorMessage(error, 'Unknown diagnostics export error'),
                        },
                    }),
                },
            );
        },
    },
    updates: { check: checkForUpdates },
};

export function isCommandAvailable(
    command: string,
    context: CommandContext = commandContext,
): boolean {
    const definition = getRegisteredCommand(command);
    return Boolean(definition && (!definition.when || definition.when(context)));
}

/**
 * Entry point for the palette, buttons, tabs, and the shortcut dispatcher. Looks the command up in the registry
 * populated by `./definitions`; an unknown id surfaces exactly one error toast instead of throwing, since it may be
 * reached from a stale keybinding or menu entry.
 */
export function executeCommand(
    command: string,
    arguments_?: unknown,
    context: CommandContext = commandContext,
): void {
    const definition = getRegisteredCommand(command);
    if (!definition) {
        // Fire-and-forget: the catalog dispatcher owns activation and the shared error path.
        // eslint-disable-next-line no-void -- one command invocation owns one extension dispatch
        void executeViewCatalogShortcut(command, arguments_ === undefined ? [] : [arguments_]);
        return;
    }
    if (!isCommandAvailable(command, context)) return;
    definition.run(context, arguments_);
}

/**
 * Entry point for shortcuts and the native menu. App-wide commands must not mutate workbench state behind a modal
 * dialog, which is why the guard lives here and not in {@link executeCommand}.
 *
 * This is also the single authority for the editable-focus shortcut policy (DESIGN.md Interaction rules) on the native
 * menu path. `useCommandShortcuts` already applies the same gate — using `event.target` — before ever calling
 * `runCommand`, so a keyboard shortcut typed while a Terminal or the editor has focus never reaches here. The native
 * menu's accelerator, however, is delivered by Electron independently of that DOM keydown listener and previously
 * bypassed the policy entirely (e.g. `Cmd+N` still created a Project while a Terminal was focused). `viaAccelerator`
 * (set by the Main-process menu from `event.triggeredByAccelerator`, see `main/index.ts`) lets this function re-apply
 * the same `isEditableEventTarget` + `allowInEditable` gate — using `document.activeElement` in place of a keydown
 * `event.target` — but only for that accelerator path. A menu item invoked by an actual mouse/touch click is a
 * deliberate user action and Electron cannot report focus state for it, so it is intentionally left ungated here; the
 * tradeoff is that a non-`allowInEditable` command remains reachable by clicking the native menu while a Terminal or
 * the editor has focus, which matches the least-surprising behaviour for a mouse-driven action.
 */
export function runCommand(
    command: CommandId,
    arguments_?: unknown,
    options?: { viaAccelerator?: boolean },
): void {
    if (useDialogStore.getState().isModalOpen()) return;
    if (options?.viaAccelerator) {
        const definition = getRegisteredCommand(command);
        if (isEditableEventTarget(document.activeElement)) {
            if (definition && !definition.allowInEditable) return;
            if (!definition) {
                const cachedPermission = getCachedViewCatalogCommandAllowedInEditable(command);
                if (cachedPermission === false) return;
                if (cachedPermission === undefined) {
                    // Fire-and-forget: the manifest lookup is the fail-safe gate for a cold extension catalog.
                    // eslint-disable-next-line no-void -- one native accelerator owns one asynchronous policy lookup
                    void executeEditableViewCatalogShortcut(
                        command,
                        arguments_ === undefined ? [] : [arguments_],
                    );
                    return;
                }
            }
        }
    }
    executeCommand(command, arguments_);
}
