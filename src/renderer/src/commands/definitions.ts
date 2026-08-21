import { bottomPanelViewRegistrations } from '@shared/bottom-panel';
import type { CommandId } from '@shared/commands';
import { getCommandDefinition } from '@shared/commands';
import { inspectorModeRegistrations } from '@shared/inspector';

import type { CommandContext, CommandDefinition, SessionMruShortcutInvocation } from './registry';
import { defineCommand, registerCommand } from './registry';

const SESSION_MRU_MODIFIERS: ReadonlySet<unknown> = new Set(['Alt', 'Control', 'Meta', 'Shift']);

/**
 * Builds a registry entry whose title/category are read from the shared catalog, so the catalog stays the single source
 * of truth for id/title/category and the two tables cannot drift apart.
 */
function fromCatalog(
    id: CommandId,
    run: (context: CommandContext, arguments_?: unknown) => void,
    extra?: Partial<Pick<CommandDefinition, 'allowInEditable' | 'confirm' | 'when'>>,
): CommandDefinition {
    const catalog = getCommandDefinition(id);
    return defineCommand({ id, title: catalog.title, category: catalog.category, run, ...extra });
}

function sessionMruInvocation(arguments_: unknown): SessionMruShortcutInvocation | undefined {
    if (!arguments_ || typeof arguments_ !== 'object' || !('shortcut' in arguments_)) return;
    const shortcut = arguments_.shortcut;
    if (!shortcut || typeof shortcut !== 'object') return;
    if (!('triggerCode' in shortcut) || typeof shortcut.triggerCode !== 'string') return;
    if (!('heldModifiers' in shortcut) || !Array.isArray(shortcut.heldModifiers)) return;
    const heldModifiers = shortcut.heldModifiers.filter(
        (modifier): modifier is SessionMruShortcutInvocation['heldModifiers'][number] =>
            SESSION_MRU_MODIFIERS.has(modifier),
    );
    return { heldModifiers, triggerCode: shortcut.triggerCode };
}

function projectIdArgument(arguments_: unknown): string | undefined {
    if (!arguments_ || typeof arguments_ !== 'object' || !('projectId' in arguments_)) return;
    return typeof arguments_.projectId === 'string' ? arguments_.projectId : undefined;
}

function terminalSequenceArgument(arguments_: unknown): string | undefined {
    if (!arguments_ || typeof arguments_ !== 'object' || !('text' in arguments_)) return;
    return typeof arguments_.text === 'string' ? arguments_.text : undefined;
}

/**
 * The command table. Populated once as a module side effect; `commands/execute.ts` imports this module so every id in
 * the shared catalog has a matching registry entry before the app runs.
 */
export const commandDefinitions: CommandDefinition[] = [
    /**
     * `Cmd+O` must work from anywhere, including a focused Terminal or editor — it opens a native folder dialog and
     * types nothing into the editable surface.
     */
    fromCatalog('project.create', (context) => context.project.create(), {
        allowInEditable: true,
    }),
    fromCatalog(
        'project.delete',
        (context) => context.project.removeSelected(),
        /**
         * The native confirm dialog (naming the Project, "files on disk are not touched") already runs in Main before
         * `project.delete` resolves; this flag only documents that contract.
         */
        { confirm: true },
    ),
    fromCatalog('project.openInEditor', (context) => context.project.openInExternalEditor()),
    fromCatalog('project.customizeIcon', (context, arguments_) =>
        context.project.customizeIcon(projectIdArgument(arguments_)),
    ),
    fromCatalog('session.create', (context) => context.session.create()),
    fromCatalog(
        'session.delete',
        (context) => context.session.deleteSelected(),
        /**
         * Same native-confirm contract as `project.delete`, enforced in Main.
         */
        { confirm: true },
    ),
    fromCatalog('session.selectNext', (context) => context.session.selectAdjacent(1)),
    fromCatalog('session.selectPrevious', (context) => context.session.selectAdjacent(-1)),
    fromCatalog(
        'session.switchMru',
        (context, arguments_) => context.session.switchMru(sessionMruInvocation(arguments_)),
        { allowInEditable: true },
    ),
    /**
     * Both directions reach through a focused Terminal — history navigation is worthless if it stands down exactly
     * where the cursor usually is — and stay unavailable while their stack is empty, so the chord falls through to the
     * Terminal instead of being swallowed by a command that would do nothing.
     */
    fromCatalog('session.navigateBack', (context) => context.session.navigateHistory('back'), {
        allowInEditable: true,
        when: (context) => context.session.canNavigateHistory('back'),
    }),
    fromCatalog(
        'session.navigateForward',
        (context) => context.session.navigateHistory('forward'),
        {
            allowInEditable: true,
            when: (context) => context.session.canNavigateHistory('forward'),
        },
    ),
    fromCatalog('terminal.new', (context) => context.terminal.create(), { allowInEditable: true }),
    fromCatalog('terminal.clear', (context) => context.terminal.clearActive(), {
        allowInEditable: true,
    }),
    /**
     * `Cmd+C` is gated on a live Terminal selection rather than merely on an active Terminal: with no selection the
     * chord must fall through untouched so Monaco, inputs, and the browser's own copy handling keep working.
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
    fromCatalog(
        'workbench.action.terminal.sendSequence',
        (context, arguments_) => {
            const text = terminalSequenceArgument(arguments_);
            if (text !== undefined) context.terminal.sendSequence(text);
        },
        {
            allowInEditable: true,
            when: (context) => context.terminal.hasActive(),
        },
    ),
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
    // A split is a pane operation, so the direction only chooses the split axis and which side the new pane takes.
    ...(
        [
            ['workbench.splitLeft', 'left'],
            ['workbench.splitRight', 'right'],
            ['workbench.splitUp', 'up'],
            ['workbench.splitDown', 'down'],
        ] as const
    ).map(([id, side]) =>
        fromCatalog(id, (context) => context.workbench.splitActive(side), {
            when: (context) => context.workbench.canSplitActive(),
        }),
    ),
    ...inspectorModeRegistrations.map(({ commandId, mode }) =>
        fromCatalog(commandId, (context) => context.inspector.activateMode(mode)),
    ),
    fromCatalog('inspector.searchFiles', (context) => context.inspector.searchFiles(), {
        allowInEditable: true,
    }),
    fromCatalog('inspector.toggle', (context) => context.inspector.toggle(), {
        allowInEditable: true,
    }),
    ...bottomPanelViewRegistrations.map(({ commandId, view }) =>
        fromCatalog(commandId, (context) => context.bottomPanel.activateView(view), {
            allowInEditable: true,
        }),
    ),
    fromCatalog('bottomPanel.toggle', (context) => context.bottomPanel.toggle(), {
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
