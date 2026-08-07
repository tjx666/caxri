import { caxri } from '../lib/caxri';
import { saveActiveEditor } from '../features/editor/document-actions';
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
import {
    clearActiveTerminal,
    closeTerminal,
    createTerminal,
    restartActiveTerminal,
} from '../features/terminal/terminal-actions';
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
        restartActive: () => {
            const terminalId = activeTerminalId();
            if (terminalId) restartActiveTerminal(terminalId);
        },
        closeActive: () => {
            const terminalId = activeTerminalId();
            if (terminalId) closeTerminal(terminalId);
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
        openSettings: () => useDialogStore.getState().setSettingsOpen(true),
        openPalette: () => useDialogStore.getState().setPaletteOpen(true),
    },
    windows: {
        openProcessExplorer: () => {
            void tryCommand('Unable to open Process Explorer', () =>
                caxri.request('processExplorer.open'),
            );
        },
    },
    diagnostics: {
        export: () => {
            void tryCommand('Diagnostics export failed', async () => {
                const result = await caxri.request('diagnostics.export');
                if (result) pushToast('success', `Diagnostics exported to ${result.path}`);
            });
        },
    },
};

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
    if (definition.when && !definition.when(context)) return;
    definition.run(context, args);
}

/**
 * Entry point for shortcuts and the native menu. App-wide commands must not mutate workbench state
 * behind a modal dialog, which is why the guard lives here and not in {@link executeCommand}.
 */
export function runCommand(command: string, args?: unknown): void {
    if (useDialogStore.getState().isModalOpen()) return;
    executeCommand(command, args);
}
