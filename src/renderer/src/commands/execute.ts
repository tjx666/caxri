import type { InspectorMode } from '@shared/types';

import { caxri } from '../lib/caxri';
import { saveActiveEditor } from '../features/editor/document-actions';
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
import { useDialogStore } from '../state/dialogs';
import { getBootstrap, selectSelectedProject } from '../state/selectors';
import { getResolvedActiveWork, useSessionViewStore } from '../state/session-view';
import { pushToast, tryCommand } from '../state/toasts';

/**
 * Everything a command may reach. Passing this in keeps `executeCommand` free of module-level
 * bindings to the feature actions, so a test can drive the table with fakes.
 */
export interface CommandContext {
    project: { create(): void; removeSelected(): void };
    session: { create(): void; deleteSelected(): void; selectAdjacent(delta: 1 | -1): void };
    terminal: { create(): void; clearActive(): void; restartActive(): void; closeActive(): void };
    editor: { saveActive(): void };
    inspector: { setMode(mode: InspectorMode): void };
    dialogs: { openSettings(): void; openPalette(): void };
    diagnostics: { export(): void };
}

function activeTerminalId(): string | undefined {
    const active = getResolvedActiveWork();
    return active?.kind === 'terminal' ? active.terminalId : undefined;
}

export const commandContext: CommandContext = {
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
    inspector: { setMode: (mode) => useSessionViewStore.getState().setInspectorMode(mode) },
    dialogs: {
        openSettings: () => useDialogStore.getState().setSettingsOpen(true),
        openPalette: () => useDialogStore.getState().setPaletteOpen(true),
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
 * The command table. A follow-up package replaces this switch with a registry; keeping the shape
 * unchanged for now makes that swap a pure move rather than a behavioural change.
 */
export function executeCommand(command: string, context: CommandContext = commandContext): void {
    switch (command) {
        case 'project.create':
            context.project.create();
            break;
        case 'project.delete':
            context.project.removeSelected();
            break;
        case 'session.create':
            context.session.create();
            break;
        case 'session.delete':
            context.session.deleteSelected();
            break;
        case 'session.selectNext':
            context.session.selectAdjacent(1);
            break;
        case 'session.selectPrevious':
            context.session.selectAdjacent(-1);
            break;
        case 'terminal.new':
            context.terminal.create();
            break;
        case 'terminal.clear':
            context.terminal.clearActive();
            break;
        case 'terminal.restart':
            context.terminal.restartActive();
            break;
        case 'terminal.close':
            context.terminal.closeActive();
            break;
        case 'editor.save':
            context.editor.saveActive();
            break;
        case 'inspector.showFiles':
            context.inspector.setMode('files');
            break;
        case 'inspector.showGit':
            context.inspector.setMode('git');
            break;
        case 'inspector.showInfo':
            context.inspector.setMode('info');
            break;
        case 'theme.openSettings':
            context.dialogs.openSettings();
            break;
        case 'commandPalette.open':
            context.dialogs.openPalette();
            break;
        case 'diagnostics.export':
            context.diagnostics.export();
            break;
    }
}

/**
 * Entry point for shortcuts and the native menu. App-wide commands must not mutate workbench state
 * behind a modal dialog, which is why the guard lives here and not in {@link executeCommand}.
 */
export function runCommand(command: string): void {
    if (useDialogStore.getState().isModalOpen()) return;
    executeCommand(command);
}
