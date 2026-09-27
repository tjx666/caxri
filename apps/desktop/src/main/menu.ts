import type { CommandDefinition, CommandId, Keybinding, NativeMenuId } from '@caxri/protocol';
import {
    buildChordLeadingChords,
    formatShortcut,
    getNativeMenuCommandGroups,
    normalizeShortcut,
    shortcutLeadingChord,
} from '@caxri/protocol';
import type { BaseWindow, KeyboardEvent, MenuItem, MenuItemConstructorOptions } from 'electron';

import { electronAccelerator } from './menu-accelerator';

export interface AppMenuOptions {
    keybindings: Keybinding[];
    dispatchCommand: (command: CommandId, isViaAccelerator: boolean) => void;
    openProcessExplorer: () => void;
    openAgentCommander: () => void;
    stopAgentCommander: () => void;
    /**
     * The Workbench window, which runs every command-backed item. Absent while it is closed.
     */
    workbenchWindow: () => BaseWindow | undefined;
    /**
     * Restores, shows, and focuses the Workbench window.
     */
    focusWorkbench: () => void;
}

/**
 * App-level shortcuts that still reach the Workbench from another Caxri window, bringing it forward: Settings is where
 * the user goes from anywhere in the app.
 */
const APP_LEVEL_SHORTCUTS = new Set<CommandId>(['settings.open']);

/**
 * Where a command-backed item runs while another Caxri window, such as the Agent Commander or the Process Explorer, is
 * focused. Every command acts on the Workbench, which the user is not looking at: Close Tab would close a Workbench tab
 * and Restart Terminal would restart a Workbench Terminal, out of sight. So Close Tab closes the focused window, the
 * way it does in every macOS app; a shortcut typed there is dropped, because it was meant for that window, unless it is
 * app-level; and an item picked from the menu bar brings the Workbench forward first, so the user sees what it
 * changes.
 */
function commandTarget(
    commandId: CommandId,
    focused: BaseWindow | undefined,
    workbench: BaseWindow | undefined,
    isViaAccelerator: boolean,
): 'close-focused' | 'drop' | 'focus-workbench' | 'workbench' {
    if (!focused || !workbench || focused === workbench) return 'workbench';
    if (commandId === 'workbench.closeActiveTab') return 'close-focused';
    return isViaAccelerator && !APP_LEVEL_SHORTCUTS.has(commandId) ? 'drop' : 'focus-workbench';
}

/**
 * Native menu accelerators consume macOS key events before the Renderer can evaluate contextual bindings. Preserve
 * source-order precedence by leaving a global menu chord to the Renderer whenever an earlier contextual binding owns
 * the same normalized chord.
 */
function commandAccelerator(
    keybindings: readonly Keybinding[],
    commandId: string,
): string | undefined {
    const candidateIndex = keybindings.findIndex(
        (binding) => binding.command === commandId && binding.when === undefined,
    );
    if (candidateIndex === -1) return;
    const candidate = keybindings[candidateIndex];
    /**
     * Electron accelerators are one key combination; a two-chord keybinding has no accelerator form. Leave it to the
     * Renderer, which owns the chord state machine, and let {@link commandLabel} advertise it as a label hint.
     */
    if (shortcutLeadingChord(candidate.key)) return;
    const candidateChord = normalizeShortcut(candidate.key);
    /**
     * A native accelerator on a chord that opens a sequence would fire this command from the keystroke that was meant
     * to start `Cmd+K …`, and Electron consumes it before the Renderer's chord state machine ever sees it. Leave the
     * chord to the Renderer; `findKeybindingConflicts` surfaces the shadowed binding in Settings.
     */
    if (buildChordLeadingChords(keybindings).has(candidateChord)) return;
    const earlierContextualBindingOwnsChord = keybindings.some(
        (binding, index) =>
            index < candidateIndex &&
            binding.when !== undefined &&
            normalizeShortcut(binding.key) === candidateChord,
    );
    return earlierContextualBindingOwnsChord ? undefined : electronAccelerator(candidate.key);
}

/**
 * MacOS cannot display an Electron accelerator without also registering it on the native `NSMenuItem`. Terminal Copy
 * and editor-overlapping Terminal shortcuts must stay Renderer-owned so the focused surface can handle them. Append the
 * first live binding to the ordinary menu label instead, matching VS Code's fallback for non-native bindings; the
 * existing menu rebuild on `keybindings.changed` keeps the hint current without creating another configuration path.
 *
 * @see https://github.com/electron/electron/issues/18295
 * @see https://github.com/electron/electron/pull/18985
 */
function commandLabel(definition: CommandDefinition, keybindings: readonly Keybinding[]): string {
    const binding = keybindings.find((candidate) => candidate.command === definition.id);
    if (!binding) return definition.title;
    if (!isRendererOwnedShortcut(definition.id) && !shortcutLeadingChord(binding.key))
        return definition.title;
    const shortcut = formatShortcut(binding.key);
    return shortcut ? `${definition.title} [${shortcut}]` : definition.title;
}

/**
 * Native accelerators cannot return an intercepted key to Monaco when a Terminal command declines it.
 */
function isRendererOwnedShortcut(commandId: string): boolean {
    return ['terminal.copy', 'terminal.clear', 'terminal.find', 'panel.toggle'].includes(commandId);
}

/**
 * Builds the native menu from the shared command catalog. Standard Electron roles remain explicit, while every
 * command-backed item inherits its placement, label, and configured accelerator from the same catalog/keybinding
 * sources as the Renderer.
 */
export function buildAppMenuTemplate({
    keybindings,
    dispatchCommand,
    openAgentCommander,
    openProcessExplorer,
    stopAgentCommander,
    workbenchWindow,
    focusWorkbench,
}: AppMenuOptions): MenuItemConstructorOptions[] {
    const command = (definition: CommandDefinition): MenuItemConstructorOptions => ({
        id: `command.${definition.id}`,
        label: commandLabel(definition, keybindings),
        /**
         * Native Edit > Copy owns `Cmd+C` so Monaco and inputs keep standard copy semantics. Giving the contextual
         * Terminal command the same native accelerator makes Electron dispatch it before the focused Renderer surface
         * can decline it; xterm handles the standard copy event instead. Clear and Find likewise leave `Cmd+Shift+K`
         * and `Cmd+F` to the focused surface. Other command-backed menu items retain the shared contextual-chord
         * precedence enforced by `commandAccelerator`.
         */
        accelerator: isRendererOwnedShortcut(definition.id)
            ? undefined
            : commandAccelerator(keybindings, definition.id),
        /**
         * `event.triggeredByAccelerator` tells the Renderer whether this click came from the menu's keyboard
         * accelerator (which must honour the editable-focus shortcut policy, DESIGN.md Interaction rules, the same way
         * `useCommandShortcuts` does) or an actual mouse/touch click on the menu item (a deliberate user action that
         * must keep working even while a Terminal/editor has focus).
         */
        click: (_menuItem: MenuItem, focused: BaseWindow | undefined, event: KeyboardEvent) => {
            /**
             * The Process Explorer menu must work while its diagnostic window is focused.
             */
            if (definition.id === 'processExplorer.open') return openProcessExplorer();
            /**
             * Like Process Explorer, the Agent Commander menu must work while its own window is focused, and the
             * Workbench Renderer is not the one that should run it.
             */
            if (definition.id === 'agentCommander.open') return openAgentCommander();
            if (definition.id === 'agentCommander.stop') return stopAgentCommander();
            const isViaAccelerator = event.triggeredByAccelerator === true;
            const workbench = workbenchWindow();
            switch (commandTarget(definition.id, focused, workbench, isViaAccelerator)) {
                case 'close-focused':
                    return focused?.close();
                case 'drop':
                    return;
                case 'focus-workbench':
                    focusWorkbench();
                    break;
                case 'workbench':
                    break;
            }
            dispatchCommand(definition.id, isViaAccelerator);
        },
    });
    const commandItems = (menu: NativeMenuId): MenuItemConstructorOptions[] =>
        getNativeMenuCommandGroups(menu).flatMap((group, index) => [
            ...(index === 0 ? [] : [{ type: 'separator' as const }]),
            ...group.map(command),
        ]);

    return [
        {
            label: 'Caxri',
            submenu: [
                { role: 'about' },
                { type: 'separator' },
                ...commandItems('application'),
                { type: 'separator' },
                { id: 'app.hide', role: 'hide', accelerator: 'Command+H' },
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit', label: 'Quit Caxri' },
            ],
        },
        { label: 'Project', submenu: commandItems('project') },
        { label: 'Session', submenu: commandItems('session') },
        { label: 'Terminal', submenu: commandItems('terminal') },
        {
            label: 'Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut' },
                { role: 'copy' },
                { role: 'paste' },
                { role: 'selectAll' },
            ],
        },
        {
            label: 'View',
            submenu: [
                { role: 'reload' },
                { role: 'toggleDevTools' },
                { type: 'separator' },
                ...commandItems('view'),
            ],
        },
        {
            label: 'Window',
            submenu: [
                ...commandItems('window'),
                { type: 'separator' },
                { role: 'minimize' },
                { role: 'zoom' },
                { role: 'front' },
            ],
        },
        { label: 'Help', submenu: commandItems('help') },
    ];
}
