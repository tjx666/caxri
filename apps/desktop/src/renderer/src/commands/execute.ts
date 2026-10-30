import './definitions';

import type { CommandId } from '@caxri/protocol';
import { listPaneTerminalIds, paneSplitBlockedReason, paneTabIdsToClose } from '@caxri/protocol';

import { focusNextAttentionSession } from '../features/agent-activity/agent-activity-commands';
import {
    canRunAgentChatComposerCommand,
    runAgentChatComposerCommand,
} from '../features/agent-chat/composer/agent-chat-composer-commands';
import {
    answerAgentChatApproval,
    canAnswerAgentChatApproval,
} from '../features/agent-chat/permissions/agent-chat-approval-commands';
import {
    canFocusAgentChatWaiting,
    focusAgentChatWaiting,
} from '../features/agent-chat/waiting/agent-chat-waiting-focus';
import { openAgentStatusTab } from '../features/agent-status/open-agent-status-tab';
import { takeBackFromBot } from '../features/caxri-bot/bot-handover-commands';
import { openBotHandover } from '../features/caxri-bot/bot-handover-store';
import { stopBotFromWorkbench } from '../features/caxri-bot/bot-stop-commands';
import { reopenClosedItem } from '../features/closed-items/commands';
import {
    closeDocumentTabFamily,
    closeDocumentTabs,
    saveActiveEditor,
} from '../features/editor/document-commands';
import {
    addGitReviewComment,
    canAddGitReviewComment,
} from '../features/editor/git-review-comment-commands';
import {
    canGoToReviewComment,
    goToNextReviewComment,
    goToPreviousReviewComment,
    showPendingReviewComments,
} from '../features/editor/git-review-navigation-commands';
import {
    canOpenImportLinkAtCursor,
    openImportLinkAtCursor,
} from '../features/editor/import-link-commands';
import {
    canSendActiveFileReference,
    sendActiveFileReference,
} from '../features/editor/send-file-reference';
import { openUntitledEditor } from '../features/editor/untitled/commands';
import { openEnvironmentPage } from '../features/environment-monitor/environment-monitor-page-request';
import { exportDiagnostics, openHelpPage, revealLogs } from '../features/help/help-commands';
import {
    openPerformanceMonitorWindow,
    togglePerformanceMonitor,
} from '../features/performance-monitor/monitor-commands';
import {
    canOpenActivePreview,
    openActiveFilePreview,
    openActiveFilePreviewToSide,
} from '../features/preview/preview-commands';
import { focusPrimarySidebar } from '../features/primary-sidebar/primary-sidebar-focus';
import { openProcessExplorer } from '../features/process-explorer/process-explorer-commands';
import { openSeededProjectSearch } from '../features/project-search/project-search-seed';
import {
    exportProjectsAndSessions,
    importProjectsAndSessions,
} from '../features/project-transfer/project-transfer-commands';
import { toggleScreencastMode } from '../features/screencast/screencast';
import {
    revealSecondarySidebar,
    toggleSecondarySidebar,
} from '../features/secondary-sidebar/secondary-sidebar-visibility';
import { enterAirplaneMode } from '../features/session/airplane-mode/airplane-mode-commands';
import { deleteProject, hideSelectedProject } from '../features/session/project-removal-commands';
import {
    detachSelectedSession,
    resumeSelectedSession,
} from '../features/session/session-agent-commands';
import {
    archiveSelectedSession,
    openArchivedSessions,
} from '../features/session/session-archive-commands';
import {
    canNavigateSessionHistory,
    deleteSelectedSession,
    moveTerminalToNewSession,
    navigateSessionHistory,
    openSelectedProjectInExternalEditor,
    openSelectedSessionPullRequest,
    selectAdjacentSession,
    switchMruSession,
} from '../features/session/session-commands';
import { compactWarmSessions } from '../features/session/session-compaction-commands';
import {
    beginSessionCreation,
    chooseProjectFolder,
} from '../features/session/session-creation-commands';
import {
    renameSelectedSession,
    renameSelectedSessionWithAi,
} from '../features/session/session-rename-commands';
import { openPinnedSessionAtPosition } from '../features/session/session-window-commands';
import {
    installShellCommand,
    uninstallShellCommand,
} from '../features/shell-command/shell-command-commands';
import {
    openConnectSshHostDialog,
    reconnectSshHost,
    stopSshHostServer,
} from '../features/ssh-host/ssh-host-commands';
import {
    canSelectWorkbenchRoot,
    canSwitchBranch,
    selectWorkbenchRootFromCommand,
    switchBranchFromCommand,
} from '../features/status-bar/status-bar-picker-commands';
import { cycleActiveTab } from '../features/tabs/tab-navigation';
import {
    closeTerminal,
    createDefaultTerminal,
    restartActiveTerminal,
    sendTerminalSequence,
    startNewAgentSession,
} from '../features/terminal/terminal-commands';
import { openTerminalLinkPicker } from '../features/terminal/terminal-link-actions';
import {
    clearActiveTerminal,
    copyActiveTerminalSelection,
    findInActiveTerminal,
    hasActiveTerminalSelection,
    navigateActiveTerminalCommand,
} from '../features/terminal/terminal-pane-handlers';
import {
    canSwitchTerminalSurface,
    switchTerminalToOtherSurface,
} from '../features/terminal/terminal-surface-commands';
import { checkForUpdates } from '../features/updates/update-commands';
import { openUsagePage } from '../features/usage/usage-page-request';
import {
    executeEditableViewCatalogShortcut,
    executeViewCatalogShortcut,
    getCachedViewCatalogCommandAllowedInEditable,
} from '../features/view-containers/view-container-commands';
import { stepWindowZoom } from '../features/window-zoom/window-zoom-commands';
import {
    canFocusPaneInDirection,
    focusPaneInDirection,
    getActivePaneId,
    getActivePaneTab,
    getPaneLayout,
    splitPaneTab,
} from '../features/workbench/pane-actions';
import { translate } from '../i18n';
import { caxri } from '../lib/caxri';
import { isEditableEventTarget } from '../lib/keybindings';
import { isAgentProcessRunning } from '../lib/terminal-agent-runtime';
import { useChromeLayoutStore } from '../stores/chrome-layout';
import { useDialogStore } from '../stores/dialogs';
import { isLocalOnlyAvailable, isSshHost } from '../stores/environment';
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

function activeTerminalRecord() {
    const terminalId = activeTerminalId();
    if (!terminalId) return;
    return getBootstrap()?.terminals.find((candidate) => candidate.id === terminalId);
}

function activeAgentTerminal() {
    const terminal = activeTerminalRecord();
    return terminal?.provider && isAgentProcessRunning(terminal.lastAgentProcessState)
        ? terminal
        : undefined;
}

/**
 * The active pane's tab together with the pane holding it: the target of every command that splits or closes "the
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
    revealSecondarySidebar();
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
    agentChat: {
        canRun: (command) => canRunAgentChatComposerCommand(activeTerminalId(), command),
        run: (command) => runAgentChatComposerCommand(activeTerminalId(), command),
    },
    agentChatWaiting: {
        canFocus: canFocusAgentChatWaiting,
        focus: focusAgentChatWaiting,
    },
    agentChatApproval: {
        // A modal owns the keyboard; its own Cmd+Enter must not be swallowed for a card behind it.
        canAnswer: () => !useDialogStore.getState().isModalOpen() && canAnswerAgentChatApproval(),
        answer: answerAgentChatApproval,
    },
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
            else void chooseProjectFolder();
        },
        archiveSelected: archiveSelectedSession,
        compactWarm: compactWarmSessions,
        enterAirplaneMode,
        canNavigateHistory: canNavigateSessionHistory,
        deleteSelected: deleteSelectedSession,
        detachSelected: detachSelectedSession,
        focusNextAttention: focusNextAttentionSession,
        navigateHistory: navigateSessionHistory,
        openArchived: openArchivedSessions,
        openPinned: openPinnedSessionAtPosition,
        openPullRequestSelected: openSelectedSessionPullRequest,
        renameSelected: renameSelectedSession,
        renameSelectedWithAi: renameSelectedSessionWithAi,
        resumeSelected: resumeSelectedSession,
        selectAdjacent: selectAdjacentSession,
        switchMru: switchMruSession,
        takeBackSelectedFromBot: () => {
            const session = getSelectedSession();
            if (session) takeBackFromBot(session.id);
        },
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
        canSwitchActiveSurface: () => canSwitchTerminalSurface(activeTerminalRecord()),
        switchActiveSurface: () => {
            const terminalId = activeTerminalId();
            if (terminalId) switchTerminalToOtherSurface(terminalId);
        },
        isActiveAgent: () => Boolean(activeTerminalRecord()?.provider),
        showActiveAgentStatus: () => {
            const terminal = activeTerminalRecord();
            if (terminal?.provider) openAgentStatusTab(terminal.id);
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
                closeTerminal(tab.resource.terminalId);
            } else if (tab) void closeDocumentTabs([tab.id]);
            // With no Session there is no tab, only a global page rendered in place of Welcome.
            else if (!getSelectedSession())
                useDialogStore.getState().dismissSessionlessWorkbenchPage();
        },
        canCloseOtherTabs: () => {
            const layout = getPaneLayout();
            const tab = getActivePaneTab();
            return Boolean(layout && tab && paneTabIdsToClose(layout, tab.id, 'others').length > 0);
        },
        closeOtherTabs: () => {
            const tab = getActivePaneTab();
            if (tab) void closeDocumentTabFamily(tab.id, 'others');
        },
        cycleTab: cycleActiveTab,
        // eslint-disable-next-line no-void -- intentional floating-promise discard, reopening reports its own failures
        reopenClosedItem: () => void reopenClosedItem(),
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
        newUntitledFile: openUntitledEditor,
        canSendReferenceToTerminal: canSendActiveFileReference,
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        sendReferenceToTerminal: () => void sendActiveFileReference(),
        canAddReviewComment: canAddGitReviewComment,
        addReviewComment: addGitReviewComment,
        canOpenPreview: canOpenActivePreview,
        openPreview: openActiveFilePreview,
        openPreviewToSide: openActiveFilePreviewToSide,
        canOpenImportLink: canOpenImportLinkAtCursor,
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        openImportLink: () => void openImportLinkAtCursor(),
    },
    secondarySidebar: {
        activateViewContainer: activateSecondarySidebarViewContainer,
        toggle: toggleSecondarySidebar,
    },
    panel: {
        activateViewContainer: (id) =>
            useChromeLayoutStore.getState().activatePanelViewContainer(id),
        toggle: () => useChromeLayoutStore.getState().togglePanel(),
    },
    zenMode: {
        toggle: () => useChromeLayoutStore.getState().toggleZenMode(),
    },
    primarySidebar: {
        focus: focusPrimarySidebar,
        toggle: () => useChromeLayoutStore.getState().togglePrimarySidebar(),
        toggleActivityMode: () =>
            useChromeLayoutStore.getState().togglePrimarySidebarActivityMode(),
    },
    git: {
        canSwitchBranch,
        switchBranch: switchBranchFromCommand,
        canGoToReviewComment,
        goToNextReviewComment,
        goToPreviousReviewComment,
        // eslint-disable-next-line no-void -- floating-promise discard: the command reports failure via its own toast
        showPendingReviewComments: () => void showPendingReviewComments(),
    },
    dialogs: {
        openSettings: (view = 'ui') => useDialogStore.getState().openSettings(view),
        openPalette: () => useDialogStore.getState().setPaletteOpen(true),
        openUsage: () => {
            // Usage is a Session pane tab; before the first Project exists there is no pane to open it into.
            if (getSelectedSession()) openUsagePage();
            else pushToast('info', translate('core.commands.usageNeedsProject'));
        },
        openEnvironment: () => {
            openEnvironmentPage();
        },
        openSessionSearch: () => useDialogStore.getState().setSessionSearchOpen(true),
        openKeyboardShortcuts: () => useDialogStore.getState().setKeyboardShortcutsOpen(true),
        /**
         * Opens the picker with the selected Session already checked, like its row menu's Hand Over. The picker lists
         * only Sessions Caxri Bot does not manage, so a managed one stays unchecked.
         */
        openBotHandover: () => {
            const session = getSelectedSession();
            openBotHandover(session ? [session.id] : []);
        },
        // eslint-disable-next-line no-void -- floating-promise discard: seeding never rejects
        openProjectSearch: () => void openSeededProjectSearch(),
        openPathBrowser: () => {
            const bootstrap = getBootstrap();
            if (getSelectedSession() && selectSelectedProject(bootstrap))
                useDialogStore.getState().setPathBrowserOpen(true);
        },
    },
    windows: {
        openCaxriBot: () => {
            void tryCommand(translate('core.commands.openCaxriBotFailed'), () =>
                caxri.request('caxriBot.open'),
            );
        },
        openBenchmark: () => {
            void tryCommand(translate('core.commands.openBenchmarkFailed'), () =>
                caxri.request('benchmark.open'),
            );
        },
        // eslint-disable-next-line no-void -- the stop reports its own failures through toasts
        stopCaxriBot: () => void stopBotFromWorkbench(),
        openProcessExplorer,
        // eslint-disable-next-line no-void -- floating-promise discard: the step reports failure via its own toast
        zoom: (step) => void stepWindowZoom(step),
    },
    developer: {
        openPerformanceMonitorWindow,
        reportBug: () => useDialogStore.getState().openBugReport(),
        togglePerformanceMonitor,
        toggleScreencastMode,
    },
    diagnostics: { export: exportDiagnostics },
    help: { open: openHelpPage, revealLogs },
    projectTransfer: {
        export: exportProjectsAndSessions,
        import: importProjectsAndSessions,
    },
    updates: { check: checkForUpdates },
    shellCommand: { install: installShellCommand, uninstall: uninstallShellCommand },
    sshHost: {
        isLocalOnlyAvailable: () => isLocalOnlyAvailable(),
        isSshHost: () => isSshHost(),
        connect: openConnectSshHostDialog,
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        reconnect: () => void reconnectSshHost(),
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        stopServer: () => void stopSshHostServer(),
    },
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
        void executeViewCatalogShortcut(command, arguments_ === undefined ? [] : [arguments_]);
        return;
    }
    if (!isCommandAvailable(command, context)) return;
    definition.run(context, arguments_);
}

/**
 * Entry point for shortcuts and the native menu. App-wide commands must not mutate workbench state behind a modal
 * dialog, which is why the guard lives here and not in {@link executeCommand}. A command marked `allowBehindModal`, such
 * as window zoom, still runs: it changes the window, dialog included, and Caxri Bot routes its zoom here while a
 * Workbench dialog it cannot see may be open.
 *
 * This is also the single authority for the editable-focus shortcut policy (DESIGN.md Interaction rules) on the native
 * menu path. `useCommandShortcuts` already applies the same gate (using `event.target`) before ever calling
 * `runCommand`, so a keyboard shortcut typed while a Terminal or the editor has focus never reaches here. The native
 * menu's accelerator, however, is delivered by Electron independently of that DOM keydown listener and previously
 * bypassed the policy entirely (e.g. `Cmd+N` still created a Project while a Terminal was focused). `viaAccelerator`
 * (set by the Main-process menu from `event.triggeredByAccelerator`, see `main/index.ts`) lets this function re-apply
 * the same `isEditableEventTarget` + `allowInEditable` gate (using `document.activeElement` in place of a keydown
 * `event.target`), but only for that accelerator path. A menu item invoked by an actual mouse/touch click is a
 * deliberate user action and Electron cannot report focus state for it, so it is intentionally left ungated here; the
 * tradeoff is that a non-`allowInEditable` command remains reachable by clicking the native menu while a Terminal or
 * the editor has focus, which matches the least-surprising behaviour for a mouse-driven action.
 */
export function runCommand(
    command: CommandId,
    arguments_?: unknown,
    options?: { viaAccelerator?: boolean },
): void {
    if (useDialogStore.getState().isModalOpen() && !getRegisteredCommand(command)?.allowBehindModal)
        return;
    if (options?.viaAccelerator) {
        const definition = getRegisteredCommand(command);
        if (isEditableEventTarget(document.activeElement)) {
            if (definition && !definition.allowInEditable) return;
            if (!definition) {
                const cachedPermission = getCachedViewCatalogCommandAllowedInEditable(command);
                if (cachedPermission === false) return;
                if (cachedPermission === undefined) {
                    // Fire-and-forget: the manifest lookup is the fail-safe gate for a cold extension catalog.
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
