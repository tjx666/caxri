import type { CommandDefinition, CommandId, Keybinding, NativeMenuId } from '@caxri/protocol';
import {
    buildChordLeadingChords,
    commandDefinitions,
    formatShortcut,
    getNativeMenuCommandGroups,
    normalizeShortcut,
    shortcutLeadingChord,
} from '@caxri/protocol';
import type {
    BaseWindow,
    KeyboardEvent,
    Menu,
    MenuItem,
    MenuItemConstructorOptions,
} from 'electron';

import { translateCommandTitle, translateMain } from './locale';
import { electronAccelerator } from './menu-accelerator';

export interface AppMenuOptions {
    keybindings: Keybinding[];
    dispatchCommand: (command: CommandId, isViaAccelerator: boolean) => void;
    openProcessExplorer: () => void;
    openAgentCommander: () => void;
    openBenchmark: () => void;
    /**
     * The Workbench window, which runs every command-backed item. Absent while it is closed.
     */
    workbenchWindow: () => BaseWindow | undefined;
    /**
     * Restores, shows, and focuses the Workbench window.
     */
    focusWorkbench: () => void;
    /**
     * Whether a window other than the Workbench follows the app-wide `window.zoomLevel`, as the Agent Commander does.
     */
    isFollowingAppZoom: (window: BaseWindow) => boolean;
    /**
     * Runs a command in an SSH Host window when that window is focused; returns false for any other window. An SSH Host
     * window is a full Workbench of its own, so its commands act on it rather than on the local Workbench.
     */
    dispatchToRemoteWindow?: (
        window: BaseWindow,
        command: CommandId,
        isViaAccelerator: boolean,
    ) => boolean;
}

/**
 * App-level shortcuts that still reach the Workbench from another Caxri window, bringing it forward: Settings is where
 * the user goes from anywhere in the app.
 */
const APP_LEVEL_SHORTCUTS = new Set<CommandId>(['settings.open']);

/**
 * `window.zoomLevel` is one app-wide setting that the Workbench Renderer writes. A window that follows it zooms along
 * with the Workbench, so a zoom command from there runs on the Workbench without bringing it forward: the change is
 * visible in the window the user is looking at.
 */
const WINDOW_ZOOM_COMMANDS = new Set<CommandId>(['view.zoomIn', 'view.zoomOut', 'view.resetZoom']);

/**
 * Where a command-backed item runs while another Caxri window, such as the Agent Commander or the Process Explorer, is
 * focused. Every command acts on the Workbench, which the user is not looking at: Close Tab would close a Workbench tab
 * and Restart Terminal would restart a Workbench Terminal, out of sight. So Close Tab closes the focused window, the
 * way it does in every macOS app; a zoom command runs in place when that window follows the app zoom; a shortcut typed
 * there is dropped, because it was meant for that window, unless it is app-level; and an item picked from the menu bar
 * brings the Workbench forward first, so the user sees what it changes.
 */
function commandTarget(
    commandId: CommandId,
    focused: BaseWindow | undefined,
    workbench: BaseWindow | undefined,
    isViaAccelerator: boolean,
    isFollowingAppZoom: (window: BaseWindow) => boolean,
): 'close-focused' | 'drop' | 'focus-workbench' | 'workbench' {
    if (!focused || !workbench || focused === workbench) return 'workbench';
    if (commandId === 'workbench.closeActiveTab') return 'close-focused';
    if (WINDOW_ZOOM_COMMANDS.has(commandId) && isFollowingAppZoom(focused)) return 'workbench';
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
    const title = translateCommandTitle(definition.id, definition.title);
    const binding = keybindings.find((candidate) => candidate.command === definition.id);
    if (!binding) return title;
    if (!isRendererOwnedShortcut(definition.id) && !shortcutLeadingChord(binding.key)) return title;
    const shortcut = formatShortcut(binding.key);
    return shortcut ? `${title} [${shortcut}]` : title;
}

/**
 * Native accelerators cannot return an intercepted key to Monaco when a Terminal command declines it. The Terminal
 * actions, Restart included, also run in the Agent Commander window, which dispatches their chords itself; a native
 * accelerator would reach Main instead, which drops a shortcut typed in that window.
 */
function isRendererOwnedShortcut(commandId: string): boolean {
    return [
        'terminal.copy',
        'terminal.clear',
        'terminal.find',
        'terminal.openDetectedLink',
        'terminal.restart',
        'panel.toggle',
    ].includes(commandId);
}

/**
 * Native menu items whose commands act on this Mac's disk or OS (`when: 'localMachine'` in the command catalog). An SSH
 * Host window's Renderer already hides these commands, because Main refuses them there.
 */
const LOCAL_MACHINE_MENU_ITEM_IDS = commandDefinitions
    .filter((definition) => definition.nativeMenu && definition.when === 'localMachine')
    .map((definition) => `command.${definition.id}`);

/**
 * Enables the local-machine-only items while a local window is focused and disables them while an SSH Host window is.
 * The menu bar is shared by every window, so this runs on every window focus change and after every menu rebuild.
 */
export function syncLocalMachineMenuItems(
    menu: Pick<Menu, 'getMenuItemById'> | null,
    isLocalMachine: boolean,
): void {
    if (!menu) return;
    for (const id of LOCAL_MACHINE_MENU_ITEM_IDS) {
        const item = menu.getMenuItemById(id);
        if (item) item.enabled = isLocalMachine;
    }
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
    openBenchmark,
    openProcessExplorer,
    workbenchWindow,
    focusWorkbench,
    isFollowingAppZoom,
    dispatchToRemoteWindow,
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
        click: (_menuItem: MenuItem, focused: BaseWindow | undefined, event?: KeyboardEvent) => {
            /**
             * The Process Explorer menu must work while its diagnostic window is focused.
             */
            if (definition.id === 'processExplorer.open') return openProcessExplorer();
            /**
             * Like Process Explorer, Open Agent Commander must work while its own window is focused, and the Workbench
             * Renderer is not the one that should run it. Stop is an ordinary Workbench command: only a Renderer can
             * ask before a running Commander turn ends.
             */
            if (definition.id === 'agentCommander.open') return openAgentCommander();
            // Open Benchmark raises its own window from Main too, so it also works while that window is focused.
            if (definition.id === 'benchmark.open') return openBenchmark();
            // A programmatic `MenuItem.click()` passes no event; it is a deliberate click, not an accelerator.
            const isViaAccelerator = event?.triggeredByAccelerator === true;
            if (focused && dispatchToRemoteWindow?.(focused, definition.id, isViaAccelerator))
                return;
            const workbench = workbenchWindow();
            switch (
                commandTarget(
                    definition.id,
                    focused,
                    workbench,
                    isViaAccelerator,
                    isFollowingAppZoom,
                )
            ) {
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
            /**
             * Role items carry explicit labels: Electron's defaults are English regardless of the app language, and the
             * menu has to follow the `workbench.language` setting rather than the system language.
             */
            submenu: [
                { role: 'about', label: translateMain('desktop.menu.about') },
                { type: 'separator' },
                ...commandItems('application'),
                { type: 'separator' },
                {
                    id: 'app.hide',
                    role: 'hide',
                    label: translateMain('desktop.menu.hide'),
                    accelerator: 'Command+H',
                },
                { role: 'hideOthers', label: translateMain('desktop.menu.hideOthers') },
                { role: 'unhide', label: translateMain('desktop.menu.showAll') },
                { type: 'separator' },
                { role: 'quit', label: translateMain('desktop.menu.quit') },
            ],
        },
        { label: translateMain('desktop.menu.project'), submenu: commandItems('project') },
        { label: translateMain('desktop.menu.session'), submenu: commandItems('session') },
        { label: translateMain('desktop.menu.terminal'), submenu: commandItems('terminal') },
        {
            label: translateMain('desktop.menu.edit'),
            submenu: [
                { role: 'undo', label: translateMain('desktop.menu.undo') },
                { role: 'redo', label: translateMain('desktop.menu.redo') },
                { type: 'separator' },
                { role: 'cut', label: translateMain('desktop.menu.cut') },
                { role: 'copy', label: translateMain('desktop.menu.copy') },
                { role: 'paste', label: translateMain('desktop.menu.paste') },
                { role: 'selectAll', label: translateMain('desktop.menu.selectAll') },
            ],
        },
        {
            label: translateMain('desktop.menu.view'),
            submenu: [
                { role: 'reload', label: translateMain('desktop.menu.reload') },
                { role: 'toggleDevTools', label: translateMain('desktop.menu.toggleDevTools') },
                { type: 'separator' },
                ...commandItems('view'),
            ],
        },
        /**
         * `windowMenu` and `help` roles on the top-level items register them with AppKit as the Window and Help menus:
         * macOS then appends the open-window list and the Help search field. An explicit submenu replaces Electron's
         * default items, so the labels still follow `workbench.language`.
         */
        {
            role: 'windowMenu',
            label: translateMain('desktop.menu.window'),
            submenu: [
                ...commandItems('window'),
                { type: 'separator' },
                { role: 'minimize', label: translateMain('desktop.menu.minimize') },
                { role: 'zoom', label: translateMain('desktop.menu.zoom') },
                { role: 'front', label: translateMain('desktop.menu.bringAllToFront') },
            ],
        },
        { role: 'help', label: translateMain('desktop.menu.help'), submenu: commandItems('help') },
    ];
}
