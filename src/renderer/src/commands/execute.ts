import { caxri } from '../lib/caxri';
import { closeEditor, saveActiveEditor } from '../features/editor/document-actions';
import {
    closeFileSearch,
    requestFileSearchFocus,
} from '../features/inspector/panels/files/file-search-state';
import {
    beginSessionCreation,
    chooseProjectDirectory,
    deleteSelectedProject,
    deleteSelectedSession,
    selectAdjacentSession,
} from '../features/session/session-actions';
import { toggleScreencastMode } from '../features/screencast/screencast';
import {
    clearActiveTerminal,
    closeTerminal,
    createTerminal,
    findInActiveTerminal,
    restartActiveTerminal,
    startNewAgentSession,
} from '../features/terminal/terminal-actions';
import { checkForUpdates } from '../features/updates/update-actions';
import { isEditableEventTarget } from '../lib/keybindings';
import { useDialogStore } from '../stores/dialogs';
import { usePanelLayoutStore } from '../stores/panel-layout';
import { getBootstrap, getSelectedSession, selectSelectedProject } from '../stores/selectors';
import { getResolvedActiveWork, useSessionViewStore } from '../stores/session-view';
import { pushToast, tryCommand } from '../stores/toasts';
import './definitions';
import { getRegisteredCommand, type CommandContext } from './registry';

export type { CommandContext } from './registry';

function activeTerminalId(): string | undefined {
    const active = getResolvedActiveWork();
    return active?.kind === 'terminal' ? active.terminalId : undefined;
}

const commandContext: CommandContext = {
    project: {
        create: () => void chooseProjectDirectory(),
        removeSelected: deleteSelectedProject,
    },
    session: {
        create: () => {
            const project = selectSelectedProject(getBootstrap());
            if (project) beginSessionCreation(project.id);
            else void chooseProjectDirectory();
        },
        deleteSelected: deleteSelectedSession,
        selectAdjacent: selectAdjacentSession,
    },
    terminal: {
        create: () => void createTerminal('shell'),
        clearActive: () => {
            const terminalId = activeTerminalId();
            if (terminalId) clearActiveTerminal(terminalId);
        },
        findActive: () => {
            const terminalId = activeTerminalId();
            if (terminalId) findInActiveTerminal(terminalId);
        },
        hasActive: () => Boolean(activeTerminalId()),
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
            const active = getResolvedActiveWork();
            if (active?.kind === 'terminal') closeTerminal(active.terminalId);
            else if (active?.kind === 'editor') closeEditor(active.path);
        },
    },
    editor: { saveActive: () => void saveActiveEditor() },
    inspector: {
        searchFiles: () => {
            const session = getSelectedSession();
            if (!session) return;
            usePanelLayoutStore.getState().setInspectorVisible(true);
            useSessionViewStore.getState().setInspectorMode('files');
            requestFileSearchFocus(session.id);
        },
        setMode: (mode) => {
            const session = getSelectedSession();
            if (session && mode !== 'files') closeFileSearch(session.id);
            useSessionViewStore.getState().setInspectorMode(mode);
        },
        toggle: () => usePanelLayoutStore.getState().toggleInspector(),
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
 * Entry point for the palette, buttons, tabs, and the shortcut dispatcher. Looks the command up in
 * the registry populated by `./definitions`; an unknown id surfaces exactly one error toast instead
 * of throwing, since it may be reached from a stale keybinding or menu entry.
 */
export function executeCommand(
    command: string,
    args?: unknown,
    context: CommandContext = commandContext,
): void {
    const definition = getRegisteredCommand(command);
    if (!definition) {
        pushToast('error', `Unknown command: ${command}`);
        return;
    }
    if (!isCommandAvailable(command, context)) return;
    definition.run(context, args);
}

/**
 * Entry point for shortcuts and the native menu. App-wide commands must not mutate workbench state
 * behind a modal dialog, which is why the guard lives here and not in {@link executeCommand}.
 *
 * This is also the single authority for the editable-focus shortcut policy (DESIGN.md:121-123) on
 * the native menu path: `useCommandShortcuts` already applies the same gate — using
 * `event.target` — before ever calling `runCommand`, so a keyboard shortcut typed while a Terminal
 * or the editor has focus never reaches here. The native menu's accelerator, however, is delivered
 * by Electron independently of that DOM keydown listener and previously bypassed the policy
 * entirely (e.g. `Cmd+N` still created a Project while a Terminal was focused). `viaAccelerator`
 * (set by the Main-process menu from `event.triggeredByAccelerator`, see `main/index.ts`) lets this
 * function re-apply the same `isEditableEventTarget` + `allowInEditable` gate — using
 * `document.activeElement` in place of a keydown `event.target` — but only for that accelerator
 * path. A menu item invoked by an actual mouse/touch click is a deliberate user action and Electron
 * cannot report focus state for it, so it is intentionally left ungated here; the tradeoff is that
 * a non-`allowInEditable` command remains reachable by clicking the native menu while a Terminal or
 * the editor has focus, which matches the least-surprising behaviour for a mouse-driven action.
 */
export function runCommand(
    command: string,
    args?: unknown,
    options?: { viaAccelerator?: boolean },
): void {
    if (useDialogStore.getState().isModalOpen()) return;
    if (options?.viaAccelerator) {
        const definition = getRegisteredCommand(command);
        if (isEditableEventTarget(document.activeElement) && !definition?.allowInEditable) return;
    }
    executeCommand(command, args);
}
