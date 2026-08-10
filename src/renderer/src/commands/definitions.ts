import { getCommandDefinition } from '@shared/commands';
import { inspectorModeRegistrations } from '@shared/inspector';

import {
    defineCommand,
    registerCommand,
    type CommandContext,
    type CommandDefinition,
} from './registry';

/**
 * Builds a registry entry whose title/category are read from the shared catalog, so the catalog
 * stays the single source of truth for id/title/category and the two tables cannot drift apart.
 */
function fromCatalog(
    id: string,
    run: (ctx: CommandContext, args?: unknown) => void,
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
    fromCatalog('project.create', (ctx) => ctx.project.create()),
    fromCatalog(
        'project.delete',
        (ctx) => ctx.project.removeSelected(),
        /** The native confirm dialog (naming the Project, "files on disk are not touched") already
         *  runs in Main before `project.delete` resolves; this flag only documents that contract. */
        { confirm: true },
    ),
    fromCatalog('session.create', (ctx) => ctx.session.create()),
    fromCatalog(
        'session.delete',
        (ctx) => ctx.session.deleteSelected(),
        /** Same native-confirm contract as `project.delete`, enforced in Main. */
        { confirm: true },
    ),
    fromCatalog('session.selectNext', (ctx) => ctx.session.selectAdjacent(1)),
    fromCatalog('session.selectPrevious', (ctx) => ctx.session.selectAdjacent(-1)),
    fromCatalog('terminal.new', (ctx) => ctx.terminal.create(), { allowInEditable: true }),
    fromCatalog('terminal.clear', (ctx) => ctx.terminal.clearActive(), { allowInEditable: true }),
    fromCatalog('terminal.restart', (ctx) => ctx.terminal.restartActive()),
    fromCatalog('terminal.close', (ctx) => ctx.terminal.closeActive(), { allowInEditable: true }),
    fromCatalog('workbench.closeActiveTab', (ctx) => ctx.workbench.closeActiveTab(), {
        allowInEditable: true,
    }),
    fromCatalog('editor.save', (ctx) => ctx.editor.saveActive(), { allowInEditable: true }),
    ...inspectorModeRegistrations.map(({ commandId, mode }) =>
        fromCatalog(commandId, (ctx) => ctx.inspector.setMode(mode)),
    ),
    fromCatalog('inspector.searchFiles', (ctx) => ctx.inspector.searchFiles(), {
        allowInEditable: true,
    }),
    fromCatalog('inspector.toggle', (ctx) => ctx.inspector.toggle(), { allowInEditable: true }),
    fromCatalog('sidebar.toggle', (ctx) => ctx.sidebar.toggle(), { allowInEditable: true }),
    fromCatalog('settings.open', (ctx) => ctx.dialogs.openSettings(), { allowInEditable: true }),
    fromCatalog('updates.check', (ctx) => ctx.updates.check()),
    fromCatalog('pathBrowser.open', (ctx) => ctx.dialogs.openPathBrowser(), {
        allowInEditable: true,
    }),
    fromCatalog('commandPalette.open', (ctx) => ctx.dialogs.openPalette(), {
        allowInEditable: true,
    }),
    fromCatalog('processExplorer.open', (ctx) => ctx.windows.openProcessExplorer()),
    fromCatalog('diagnostics.export', (ctx) => ctx.diagnostics.export()),
];

for (const definition of commandDefinitions) registerCommand(definition);
