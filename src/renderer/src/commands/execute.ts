import './definitions';

import type { CommandId } from '@shared/commands';
import { listPanes } from '@shared/pane-layout';

import { closeDocumentTabs, saveActiveEditor } from '../features/editor/document-actions';
import {
    closeFileSearch,
    requestFileSearchFocus,
} from '../features/inspector/panels/files/file-search-state';
import { toggleScreencastMode } from '../features/screencast/screencast';
import {
    beginSessionCreation,
    canNavigateSessionHistory,
    chooseProjectDirectory,
    deleteSelectedProject,
    deleteSelectedSession,
    navigateSessionHistory,
    openSelectedProjectInExternalEditor,
    selectAdjacentSession,
    switchMruSession,
} from '../features/session/session-actions';
import { cycleActiveTab } from '../features/tabs/tab-navigation';
import {
    clearActiveTerminal,
    closeTerminal,
    copyActiveTerminalSelection,
    createTerminal,
    findInActiveTerminal,
    hasActiveTerminalSelection,
    navigateActiveTerminalCommand,
    restartActiveTerminal,
    sendTerminalSequence,
    startNewAgentSession,
} from '../features/terminal/terminal-actions';
import { checkForUpdates } from '../features/updates/update-actions';
import {
    getActivePaneId,
    getActivePaneTab,
    getPaneLayout,
    splitPaneTab,
} from '../features/workbench/pane-actions';
import { caxri } from '../lib/caxri';
import { isEditableEventTarget } from '../lib/keybindings';
import { useDialogStore } from '../stores/dialogs';
import { usePanelLayoutStore } from '../stores/panel-layout';
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
    return terminal?.provider && terminal.lastProcessState === 'running' ? terminal : undefined;
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
 * Makes an Inspector mode reachable before persisting it into the selected Session. Callers such as the Status Bar and
 * Command Palette must share this boundary so selecting a mode cannot leave the Inspector collapsed.
 */
function activateInspectorMode(
    mode: Parameters<CommandContext['inspector']['activateMode']>[0],
): void {
    const session = getSelectedSession();
    if (!session) return;
    if (!usePanelLayoutStore.getState().inspectorVisible)
        usePanelLayoutStore.getState().setInspectorVisible(true);
    if (mode !== 'files') closeFileSearch(session.id);
    useSessionViewStore.getState().setInspectorMode(mode);
}

/**
 * `terminal.copy` binds `Cmd+C`, the single most overloaded chord in the app, and is `allowInEditable` so it can reach
 * through the xterm surface. Availability therefore cannot rest on "the active tab is a terminal with a selection"
 * alone: a sidebar rename field or the path browser input can hold focus while a stale terminal selection is still
 * highlighted behind them, and hijacking their `Cmd+C` would silently copy the wrong text. Requiring focus to actually
 * sit inside the terminal keeps the chord falling through to the native copy everywhere else.
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
        create: () => void chooseProjectDirectory(),
        customizeIcon: (projectId) => {
            const target =
                getBootstrap()?.projects.find((project) => project.id === projectId) ??
                selectSelectedProject(getBootstrap());
            if (target) useDialogStore.getState().openProjectIcon(target.id);
        },
        openInExternalEditor: openSelectedProjectInExternalEditor,
        removeSelected: deleteSelectedProject,
    },
    session: {
        create: () => {
            const project = selectSelectedProject(getBootstrap());
            if (project) beginSessionCreation(project.id);
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            else void chooseProjectDirectory();
        },
        canNavigateHistory: canNavigateSessionHistory,
        deleteSelected: deleteSelectedSession,
        navigateHistory: navigateSessionHistory,
        selectAdjacent: selectAdjacentSession,
        switchMru: switchMruSession,
    },
    terminal: {
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        create: () => void createTerminal('shell'),
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

            console.log('DIAG_CLOSEACTIVETAB', {
                tabId: tab?.id,
                tabKind: tab?.resource.kind,
                activePaneId: getActivePaneId(),
            });
            if (tab?.resource.kind === 'terminal') closeTerminal(tab.resource.terminalId);
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
            const pane = listPanes(layout).find((candidate) => candidate.id === target.paneId);
            return (pane?.tabs.length ?? 0) > 1;
        },
        splitActive: (direction) => {
            const target = activePaneTarget();
            if (target) splitPaneTab(target.tabId, target.paneId, direction);
        },
    },
    editor: {
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        saveActive: () => void saveActiveEditor(),
    },
    inspector: {
        searchFiles: () => {
            const session = getSelectedSession();
            if (!session) return;
            activateInspectorMode('files');
            requestFileSearchFocus(session.id);
        },
        activateMode: activateInspectorMode,
        toggle: () => usePanelLayoutStore.getState().toggleInspector(),
    },
    bottomPanel: {
        activateView: (view) => usePanelLayoutStore.getState().activateBottomPanelView(view),
        toggle: () => usePanelLayoutStore.getState().toggleBottomPanel(),
    },
    sidebar: { toggle: () => usePanelLayoutStore.getState().toggleSidebar() },
    dialogs: {
        openSettings: (view = 'ui') => useDialogStore.getState().openSettings(view),
        openPalette: () => useDialogStore.getState().setPaletteOpen(true),
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
            void tryCommand('Diagnostics export failed', async () => {
                const result = await caxri.request('diagnostics.export');
                if (result) pushToast('success', `Diagnostics exported to ${result.path}`);
            });
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
    command: CommandId,
    arguments_?: unknown,
    context: CommandContext = commandContext,
): void {
    const definition = getRegisteredCommand(command);
    if (!definition) {
        pushToast('error', `Unknown command: ${command}`);
        return;
    }
    if (!isCommandAvailable(command, context)) return;
    definition.run(context, arguments_);
}

/**
 * Entry point for shortcuts and the native menu. App-wide commands must not mutate workbench state behind a modal
 * dialog, which is why the guard lives here and not in {@link executeCommand}.
 *
 * This is also the single authority for the editable-focus shortcut policy (DESIGN.md:121-123) on the native menu path:
 * `useCommandShortcuts` already applies the same gate — using `event.target` — before ever calling `runCommand`, so a
 * keyboard shortcut typed while a Terminal or the editor has focus never reaches here. The native menu's accelerator,
 * however, is delivered by Electron independently of that DOM keydown listener and previously bypassed the policy
 * entirely (e.g. `Cmd+N` still created a Project while a Terminal was focused). `viaAccelerator` (set by the
 * Main-process menu from `event.triggeredByAccelerator`, see `main/index.ts`) lets this function re-apply the same
 * `isEditableEventTarget` + `allowInEditable` gate — using `document.activeElement` in place of a keydown
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
    if (command === 'workbench.closeActiveTab') {
        console.log('DIAG_RUNCOMMAND', {
            command,
            isModalOpen: useDialogStore.getState().isModalOpen(),
            openModalIds: Array.from(useDialogStore.getState().openModalIds),
            activeElement: document.activeElement?.tagName,
            viaAccelerator: options?.viaAccelerator,
        });
    }
    if (useDialogStore.getState().isModalOpen()) return;
    if (options?.viaAccelerator) {
        const definition = getRegisteredCommand(command);
        if (isEditableEventTarget(document.activeElement) && !definition?.allowInEditable) return;
    }
    executeCommand(command, arguments_);
}
