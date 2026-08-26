import type { CommandDefinition, CommandId, Keybinding, NativeMenuId } from '@caxri/protocol';
import { formatShortcut, getNativeMenuCommandGroups, normalizeShortcut } from '@caxri/protocol';
import type { BaseWindow, KeyboardEvent, MenuItem, MenuItemConstructorOptions } from 'electron';

export interface AppMenuOptions {
    keybindings: Keybinding[];
    dispatchCommand: (command: CommandId, isViaAccelerator: boolean) => void;
    openProcessExplorer: () => void;
}

/**
 * Keybinding key names are DOM `KeyboardEvent.key` values lowercased; Electron accelerators use its own token set. Any
 * name that differs between the two has to be translated explicitly — an unmapped name falls through uppercased, and
 * Electron silently refuses to register the accelerator (`ARROWLEFT` is not a token, `Left` is), leaving the menu item
 * with no working shortcut even though the Renderer's own DOM handler still fires.
 *
 * @see https://www.electronjs.org/docs/latest/api/accelerator
 */
function electronAccelerator(key: string | undefined): string | undefined {
    if (!key) return undefined;
    const names: Record<string, string> = {
        'cmd': 'Command',
        'command': 'Command',
        'ctrl': 'Control',
        'control': 'Control',
        'alt': 'Alt',
        'option': 'Alt',
        'shift': 'Shift',
        'arrowup': 'Up',
        'arrowdown': 'Down',
        'arrowleft': 'Left',
        'arrowright': 'Right',
        'escape': 'Escape',
        'enter': 'Return',
        'backspace': 'Backspace',
        'delete': 'Delete',
        ' ': 'Space',
        'space': 'Space',
    };
    return key
        .split('+')
        .map((part) => names[part.trim().toLowerCase()] ?? part.trim().toUpperCase())
        .join('+');
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
    const candidateChord = normalizeShortcut(candidate.key);
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
 * must stay Renderer-owned so the active Editor, input, or Terminal selection decides what `Cmd+C` means. Append the
 * first live binding to the ordinary menu label instead, matching VS Code's fallback for non-native bindings; the
 * existing menu rebuild on `keybindings.changed` keeps the hint current without creating another configuration path.
 *
 * @see https://github.com/electron/electron/issues/18295
 * @see https://github.com/electron/electron/pull/18985
 */
function commandLabel(definition: CommandDefinition, keybindings: readonly Keybinding[]): string {
    if (definition.id !== 'terminal.copy') return definition.title;
    const binding = keybindings.find((candidate) => candidate.command === definition.id);
    if (!binding) return definition.title;
    const shortcut = formatShortcut(binding.key);
    return shortcut ? `${definition.title} [${shortcut}]` : definition.title;
}

/**
 * Builds the native menu from the shared command catalog. Standard Electron roles remain explicit, while every
 * command-backed item inherits its placement, label, and configured accelerator from the same catalog/keybinding
 * sources as the Renderer.
 */
export function buildAppMenuTemplate({
    keybindings,
    dispatchCommand,
    openProcessExplorer,
}: AppMenuOptions): MenuItemConstructorOptions[] {
    const command = (definition: CommandDefinition): MenuItemConstructorOptions => ({
        id: `command.${definition.id}`,
        label: commandLabel(definition, keybindings),
        /**
         * Native Edit > Copy owns `Cmd+C` so Monaco and inputs keep standard copy semantics. Giving the contextual
         * Terminal command the same native accelerator makes Electron dispatch it before the focused Renderer surface
         * can decline it; xterm handles the standard copy event instead. Other command-backed menu items retain the
         * shared contextual-chord precedence enforced by `commandAccelerator`.
         */
        accelerator:
            definition.id === 'terminal.copy'
                ? undefined
                : commandAccelerator(keybindings, definition.id),
        /**
         * `event.triggeredByAccelerator` tells the Renderer whether this click came from the menu's keyboard
         * accelerator (which must honour the editable-focus shortcut policy, DESIGN.md:121-123, the same way
         * `useCommandShortcuts` does) or an actual mouse/touch click on the menu item (a deliberate user action that
         * must keep working even while a Terminal/editor has focus).
         */
        click: (_menuItem: MenuItem, _window: BaseWindow | undefined, event: KeyboardEvent) => {
            /**
             * The Process Explorer menu must work while its diagnostic window is focused.
             */
            if (definition.id === 'processExplorer.open') return openProcessExplorer();
            dispatchCommand(definition.id, event.triggeredByAccelerator === true);
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
                { role: 'quit', label: 'Quit Caxri Desktop' },
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
