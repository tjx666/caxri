import type { BaseWindow, KeyboardEvent, MenuItem, MenuItemConstructorOptions } from 'electron';

import {
    getNativeMenuCommandGroups,
    type CommandDefinition,
    type CommandId,
    type NativeMenuId,
} from '../shared/commands';
import type { Keybinding } from '../shared/types';

export interface ApplicationMenuOptions {
    keybindings: Keybinding[];
    dispatchCommand: (command: CommandId, viaAccelerator: boolean) => void;
    openProcessExplorer: () => void;
}

function electronAccelerator(key: string | undefined): string | undefined {
    if (!key) return undefined;
    const names: Record<string, string> = {
        cmd: 'Command',
        command: 'Command',
        ctrl: 'Control',
        control: 'Control',
        alt: 'Alt',
        option: 'Alt',
        shift: 'Shift',
    };
    return key
        .split('+')
        .map((part) => names[part.trim().toLowerCase()] ?? part.trim().toUpperCase())
        .join('+');
}

/**
 * Builds the native menu from the shared command catalog. Standard Electron roles remain explicit,
 * while every command-backed item inherits its placement, label, and configured accelerator from
 * the same catalog/keybinding sources as the Renderer.
 */
export function buildApplicationMenuTemplate({
    keybindings,
    dispatchCommand,
    openProcessExplorer,
}: ApplicationMenuOptions): MenuItemConstructorOptions[] {
    const accelerator = (id: string): string | undefined =>
        electronAccelerator(keybindings.find((binding) => binding.command === id)?.key);
    const command = (definition: CommandDefinition): MenuItemConstructorOptions => ({
        id: `command.${definition.id}`,
        label: definition.title,
        accelerator: accelerator(definition.id),
        /**
         * `event.triggeredByAccelerator` tells the Renderer whether this click came from the menu's
         * keyboard accelerator (which must honour the editable-focus shortcut policy, DESIGN.md:121-123,
         * the same way `useCommandShortcuts` does) or an actual mouse/touch click on the menu item
         * (a deliberate user action that must keep working even while a Terminal/editor has focus).
         */
        click: (_menuItem: MenuItem, _window: BaseWindow | undefined, event: KeyboardEvent) => {
            /** The Process Explorer menu must work while its diagnostic window is focused. */
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
