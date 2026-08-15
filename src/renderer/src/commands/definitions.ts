import type { CommandId } from '@shared/commands';
import { getCommandDefinition } from '@shared/commands';
import { inspectorModeRegistrations } from '@shared/inspector';

import type { CommandContext, CommandDefinition } from './registry';
import { defineCommand, registerCommand } from './registry';

/**
 * Builds a registry entry whose title/category are read from the shared catalog, so the catalog
 * stays the single source of truth for id/title/category and the two tables cannot drift apart.
 */
function fromCatalog(
    id: CommandId,
    run: (context: CommandContext, arguments_?: unknown) => void,
    extra?: Partial<Pick<CommandDefinition, 'allowInEditable' | 'confirm' | 'when'>>,
): CommandDefinition {
    const catalog = getCommandDefinition(id);
    return defineCommand({ id, title: catalog.title, category: catalog.category, run, ...extra });
}

/**
 * The command table. Populated once as a module side effect; `commands/execute.ts` imports this
 * module so every id in the shared catalog has a matching registry entry before the app runs.
 */
export const commandDefinitions: CommandDefinition[] = [
    fromCatalog('project.create', (context) => context.project.create()),
    fromCatalog(
        'project.delete',
        (context) => context.project.removeSelected(),
        /**
         * The native confirm dialog (naming the Project, "files on disk are not touched") already
         *  runs in Main before `project.delete` resolves; this flag only documents that contract.
         */
        { confirm: true },
    ),
    fromCatalog('session.create', (context) => context.session.create()),
    fromCatalog(
        'session.delete',
        (context) => context.session.deleteSelected(),
        /**
        Same native-confirm contract as `project.delete`, enforced in Main.
         */
        { confirm: true },
    ),
    fromCatalog('session.selectNext', (context) => context.session.selectAdjacent(1)),
    fromCatalog('session.selectPrevious', (context) => context.session.selectAdjacent(-1)),
    fromCatalog('terminal.new', (context) => context.terminal.create(), { allowInEditable: true }),
    fromCatalog('terminal.clear', (context) => context.terminal.clearActive(), {
        allowInEditable: true,
    }),
    /**
     * `Cmd+C` is gated on a live Terminal selection rather than merely on an active Terminal: with
     * no selection the chord must fall through untouched so Monaco, inputs, and the browser's own
     * copy handling keep working.
     */
    fromCatalog('terminal.copy', (context) => context.terminal.copySelection(), {
        allowInEditable: true,
        when: (context) => context.terminal.hasSelection(),
    }),
    fromCatalog('terminal.find', (context) => context.terminal.findActive(), {
        allowInEditable: true,
        when: (context) => context.terminal.hasActive(),
    }),
    fromCatalog('terminal.previousCommand', (context) => context.terminal.navigateCommand(-1), {
        allowInEditable: true,
        when: (context) => context.terminal.hasActive(),
    }),
    fromCatalog('terminal.nextCommand', (context) => context.terminal.navigateCommand(1), {
        allowInEditable: true,
        when: (context) => context.terminal.hasActive(),
    }),
    fromCatalog('terminal.restart', (context) => context.terminal.restartActive()),
    fromCatalog('terminal.startNewAgentSession', (context) =>
        context.terminal.startNewAgentSession(),
    ),
    fromCatalog('terminal.close', (context) => context.terminal.closeActive(), {
        allowInEditable: true,
    }),
    fromCatalog('workbench.closeActiveTab', (context) => context.workbench.closeActiveTab(), {
        allowInEditable: true,
    }),
    fromCatalog('workbench.nextTab', (context) => context.workbench.cycleTab(1), {
        allowInEditable: true,
    }),
    fromCatalog('workbench.previousTab', (context) => context.workbench.cycleTab(-1), {
        allowInEditable: true,
    }),
    fromCatalog('editor.save', (context) => context.editor.saveActive(), { allowInEditable: true }),
    ...inspectorModeRegistrations.map(({ commandId, mode }) =>
        fromCatalog(commandId, (context) => context.inspector.activateMode(mode)),
    ),
    fromCatalog('inspector.searchFiles', (context) => context.inspector.searchFiles(), {
        allowInEditable: true,
    }),
    fromCatalog('inspector.toggle', (context) => context.inspector.toggle(), {
        allowInEditable: true,
    }),
    fromCatalog('sidebar.toggle', (context) => context.sidebar.toggle(), { allowInEditable: true }),
    fromCatalog('settings.open', (context) => context.dialogs.openSettings(), {
        allowInEditable: true,
    }),
    fromCatalog('settings.openSource', (context) => context.dialogs.openSettings('source'), {
        allowInEditable: true,
    }),
    fromCatalog(
        'settings.openKeybindings',
        (context) => context.dialogs.openSettings('keybindings'),
        {
            allowInEditable: true,
        },
    ),
    fromCatalog(
        'settings.manageTrustedDomains',
        (context) => context.dialogs.openSettings('trusted-domains'),
        { allowInEditable: true },
    ),
    fromCatalog('updates.check', (context) => context.updates.check()),
    fromCatalog('pathBrowser.open', (context) => context.dialogs.openPathBrowser(), {
        allowInEditable: true,
    }),
    fromCatalog('commandPalette.open', (context) => context.dialogs.openPalette(), {
        allowInEditable: true,
    }),
    fromCatalog('processExplorer.open', (context) => context.windows.openProcessExplorer()),
    fromCatalog(
        'developer.toggleScreencastMode',
        (context) => context.developer.toggleScreencastMode(),
        {
            allowInEditable: true,
        },
    ),
    fromCatalog('developer.reportBug', (context) => context.developer.reportBug(), {
        allowInEditable: true,
    }),
    fromCatalog('diagnostics.export', (context) => context.diagnostics.export()),
];

for (const definition of commandDefinitions) registerCommand(definition);
