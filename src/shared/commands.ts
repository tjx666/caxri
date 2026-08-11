import type { Keybinding } from './types';
import { inspectorModeRegistrations } from './inspector';

export interface CommandDefinition {
    id: string;
    title: string;
    category: string;
    description: string;
    nativeMenu?: {
        menu: NativeMenuId;
        group: number;
        order: number;
    };
}

export const nativeMenuIds = [
    'application',
    'project',
    'session',
    'terminal',
    'view',
    'window',
    'help',
] as const;

export type NativeMenuId = (typeof nativeMenuIds)[number];

/** One command catalog supplies the palette, shortcuts, native menus, and command-backed buttons. */
export const commandDefinitions: CommandDefinition[] = [
    {
        id: 'project.create',
        title: 'Add Project',
        category: 'Project',
        description: 'Add a local folder as a Project',
        nativeMenu: { menu: 'project', group: 0, order: 0 },
    },
    {
        id: 'project.delete',
        title: 'Remove Project',
        category: 'Project',
        description: 'Remove the selected Project from Caxri',
        nativeMenu: { menu: 'project', group: 0, order: 1 },
    },
    {
        id: 'session.create',
        title: 'New Session',
        category: 'Session',
        description: 'Create a Session in the selected Project',
        nativeMenu: { menu: 'session', group: 0, order: 0 },
    },
    {
        id: 'session.delete',
        title: 'Remove Session',
        category: 'Session',
        description: 'Remove the selected Session and its Terminals',
        nativeMenu: { menu: 'session', group: 0, order: 1 },
    },
    {
        id: 'session.selectNext',
        title: 'Select Next Session',
        category: 'Session',
        description: 'Select the next active Session',
        nativeMenu: { menu: 'session', group: 1, order: 1 },
    },
    {
        id: 'session.selectPrevious',
        title: 'Select Previous Session',
        category: 'Session',
        description: 'Select the previous active Session',
        nativeMenu: { menu: 'session', group: 1, order: 0 },
    },
    {
        id: 'terminal.new',
        title: 'New Terminal',
        category: 'Terminal',
        description: 'Create a Terminal in the current Session',
        nativeMenu: { menu: 'terminal', group: 0, order: 0 },
    },
    {
        id: 'terminal.clear',
        title: 'Clear Terminal',
        category: 'Terminal',
        description: 'Clear the active Terminal view',
        nativeMenu: { menu: 'terminal', group: 0, order: 1 },
    },
    {
        id: 'terminal.restart',
        title: 'Restart Terminal',
        category: 'Terminal',
        description: 'Restart Shell or resume the active Agent Terminal',
        nativeMenu: { menu: 'terminal', group: 0, order: 2 },
    },
    {
        id: 'terminal.startNewAgentSession',
        title: 'Start New Agent Session',
        category: 'Terminal',
        description: 'Restart the active Agent Terminal without its current session binding',
        nativeMenu: { menu: 'terminal', group: 0, order: 3 },
    },
    {
        id: 'terminal.close',
        title: 'Close Terminal',
        category: 'Terminal',
        description: 'Close the active Terminal',
        nativeMenu: { menu: 'terminal', group: 0, order: 4 },
    },
    {
        id: 'workbench.closeActiveTab',
        title: 'Close Active Tab',
        category: 'View',
        description: 'Close the active Terminal or file tab',
        nativeMenu: { menu: 'window', group: 0, order: 0 },
    },
    {
        id: 'editor.save',
        title: 'Save File',
        category: 'Editor',
        description: 'Save the active file',
    },
    ...inspectorModeRegistrations.map(({ commandDescription, commandId, commandTitle }) => ({
        id: commandId,
        title: commandTitle,
        category: 'Inspector',
        description: commandDescription,
    })),
    {
        id: 'inspector.searchFiles',
        title: 'Search Files',
        category: 'Inspector',
        description: 'Search files in the selected Project',
        nativeMenu: { menu: 'view', group: 0, order: 0 },
    },
    {
        id: 'inspector.toggle',
        title: 'Toggle Inspector',
        category: 'Inspector',
        description: 'Show or hide the Inspector',
        nativeMenu: { menu: 'view', group: 0, order: 2 },
    },
    {
        id: 'sidebar.toggle',
        title: 'Toggle Primary Sidebar',
        category: 'View',
        description: 'Show or hide the Project Sidebar',
        nativeMenu: { menu: 'view', group: 0, order: 1 },
    },
    {
        id: 'settings.open',
        title: 'Open Settings',
        category: 'Preferences',
        description: 'Open Caxri Settings',
        nativeMenu: { menu: 'application', group: 0, order: 0 },
    },
    {
        id: 'settings.openSource',
        title: 'Open Settings (JSON)',
        category: 'Preferences',
        description: 'Open settings.jsonc in the Caxri source editor',
    },
    {
        id: 'updates.check',
        title: 'Check for Updates',
        category: 'Preferences',
        description: 'Check for a newer Caxri release',
        nativeMenu: { menu: 'application', group: 0, order: 1 },
    },
    {
        id: 'pathBrowser.open',
        title: 'Open File by Path',
        category: 'View',
        description: 'Browse the selected Project and open a file',
        nativeMenu: { menu: 'view', group: 1, order: 0 },
    },
    {
        id: 'commandPalette.open',
        title: 'Open Command Palette',
        category: 'View',
        description: 'Search and run Caxri commands',
        nativeMenu: { menu: 'view', group: 1, order: 1 },
    },
    {
        id: 'processExplorer.open',
        title: 'Open Process Explorer',
        category: 'Help',
        description: 'Inspect Caxri process resource usage',
        nativeMenu: { menu: 'help', group: 0, order: 0 },
    },
    {
        id: 'developer.toggleScreencastMode',
        title: 'Toggle Screencast Mode',
        category: 'Developer',
        description: 'Show clicks and Caxri shortcuts for external screen recording',
    },
    {
        id: 'developer.reportBug',
        title: 'Report Bug to Agent',
        category: 'Developer',
        description: 'Preview and send a privacy-safe local bug report to a running Agent',
    },
    {
        id: 'diagnostics.export',
        title: 'Export Diagnostics',
        category: 'Help',
        description: 'Export a privacy-safe diagnostics bundle',
        nativeMenu: { menu: 'help', group: 1, order: 0 },
    },
];

export function getCommandDefinition(id: string): CommandDefinition {
    const definition = commandDefinitions.find((command) => command.id === id);
    if (!definition) throw new Error(`Unknown command: ${id}`);
    return definition;
}

/** Returns command-backed native-menu groups in their declared presentation order. */
export function getNativeMenuCommandGroups(menu: NativeMenuId): CommandDefinition[][] {
    const placed = commandDefinitions
        .filter((command) => command.nativeMenu?.menu === menu)
        .sort((a, b) => {
            const aPlacement = a.nativeMenu;
            const bPlacement = b.nativeMenu;
            if (!aPlacement || !bPlacement) return 0;
            return aPlacement.group - bPlacement.group || aPlacement.order - bPlacement.order;
        });
    const groups: CommandDefinition[][] = [];
    for (const command of placed) {
        const group = command.nativeMenu?.group;
        const previous = groups.at(-1);
        if (previous && previous[0]?.nativeMenu?.group === group) previous.push(command);
        else groups.push([command]);
    }
    return groups;
}

/** Default keyboard shortcuts, seeded into `keybindings.jsonc` on first run. */
export const defaultKeybindings: Keybinding[] = [
    { key: 'cmd+p', command: 'pathBrowser.open' },
    { key: 'cmd+shift+p', command: 'commandPalette.open' },
    { key: 'cmd+n', command: 'project.create' },
    { key: 'cmd+t', command: 'terminal.new' },
    { key: 'cmd+k', command: 'terminal.clear' },
    { key: 'cmd+shift+r', command: 'terminal.restart' },
    { key: 'cmd+w', command: 'workbench.closeActiveTab' },
    { key: 'cmd+s', command: 'editor.save' },
    ...inspectorModeRegistrations.map(({ commandId, defaultKeybinding }) => ({
        key: defaultKeybinding,
        command: commandId,
    })),
    { key: 'cmd+shift+f', command: 'inspector.searchFiles' },
    { key: 'cmd+[', command: 'sidebar.toggle' },
    { key: 'cmd+]', command: 'inspector.toggle' },
    { key: 'cmd+,', command: 'settings.open' },
];
