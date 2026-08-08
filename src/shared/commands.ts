import type { Keybinding } from './types';

export interface CommandDefinition {
    id: string;
    title: string;
    category: string;
    description: string;
}

/** One command catalog supplies the palette, shortcuts, native menus, and command-backed buttons. */
export const commandDefinitions: CommandDefinition[] = [
    {
        id: 'project.create',
        title: 'Add Project',
        category: 'Project',
        description: 'Add a local folder as a Project',
    },
    {
        id: 'project.delete',
        title: 'Remove Project',
        category: 'Project',
        description: 'Remove the selected Project from Caxri',
    },
    {
        id: 'session.create',
        title: 'New Session',
        category: 'Session',
        description: 'Create a Session in the selected Project',
    },
    {
        id: 'session.delete',
        title: 'Remove Session',
        category: 'Session',
        description: 'Remove the selected Session and its Terminals',
    },
    {
        id: 'session.selectNext',
        title: 'Select Next Session',
        category: 'Session',
        description: 'Select the next active Session',
    },
    {
        id: 'session.selectPrevious',
        title: 'Select Previous Session',
        category: 'Session',
        description: 'Select the previous active Session',
    },
    {
        id: 'terminal.new',
        title: 'New Terminal',
        category: 'Terminal',
        description: 'Create a Terminal in the current Session',
    },
    {
        id: 'terminal.clear',
        title: 'Clear Terminal',
        category: 'Terminal',
        description: 'Clear the active Terminal view',
    },
    {
        id: 'terminal.restart',
        title: 'Restart Terminal',
        category: 'Terminal',
        description: 'Restart the active Terminal',
    },
    {
        id: 'terminal.close',
        title: 'Close Terminal',
        category: 'Terminal',
        description: 'Close the active Terminal',
    },
    {
        id: 'workbench.closeActiveTab',
        title: 'Close Active Tab',
        category: 'View',
        description: 'Close the active Terminal or file tab',
    },
    {
        id: 'editor.save',
        title: 'Save File',
        category: 'Editor',
        description: 'Save the active file',
    },
    {
        id: 'inspector.showFiles',
        title: 'Show Files',
        category: 'Inspector',
        description: 'Show Files in the Inspector',
    },
    {
        id: 'inspector.showGit',
        title: 'Show Git',
        category: 'Inspector',
        description: 'Show Source Control in the Inspector',
    },
    {
        id: 'inspector.showStatus',
        title: 'Show Project Status',
        category: 'Inspector',
        description: 'Show Project Status in the Inspector',
    },
    {
        id: 'inspector.showInfo',
        title: 'Show Terminal Info',
        category: 'Inspector',
        description: 'Show Terminal information in the Inspector',
    },
    {
        id: 'inspector.searchFiles',
        title: 'Search Files',
        category: 'Inspector',
        description: 'Search files in the selected Project',
    },
    {
        id: 'inspector.toggle',
        title: 'Toggle Inspector',
        category: 'Inspector',
        description: 'Show or hide the Inspector',
    },
    {
        id: 'sidebar.toggle',
        title: 'Toggle Primary Sidebar',
        category: 'View',
        description: 'Show or hide the Project Sidebar',
    },
    {
        id: 'settings.open',
        title: 'Open Settings',
        category: 'Preferences',
        description: 'Open Caxri Settings',
    },
    {
        id: 'commandPalette.open',
        title: 'Open Command Palette',
        category: 'View',
        description: 'Search and run Caxri commands',
    },
    {
        id: 'processExplorer.open',
        title: 'Open Process Explorer',
        category: 'Help',
        description: 'Inspect Caxri process resource usage',
    },
    {
        id: 'diagnostics.export',
        title: 'Export Diagnostics',
        category: 'Help',
        description: 'Export a privacy-safe diagnostics bundle',
    },
];

export function getCommandDefinition(id: string): CommandDefinition {
    const definition = commandDefinitions.find((command) => command.id === id);
    if (!definition) throw new Error(`Unknown command: ${id}`);
    return definition;
}

/** Default keyboard shortcuts, seeded into `keybindings.jsonc` on first run. */
export const defaultKeybindings: Keybinding[] = [
    { key: 'cmd+shift+p', command: 'commandPalette.open' },
    { key: 'cmd+n', command: 'project.create' },
    { key: 'cmd+t', command: 'terminal.new' },
    { key: 'cmd+k', command: 'terminal.clear' },
    { key: 'cmd+shift+r', command: 'terminal.restart' },
    { key: 'cmd+w', command: 'workbench.closeActiveTab' },
    { key: 'cmd+s', command: 'editor.save' },
    { key: 'cmd+1', command: 'inspector.showFiles' },
    { key: 'cmd+2', command: 'inspector.showGit' },
    { key: 'cmd+3', command: 'inspector.showStatus' },
    { key: 'cmd+4', command: 'inspector.showInfo' },
    { key: 'cmd+shift+f', command: 'inspector.searchFiles' },
    { key: 'cmd+[', command: 'sidebar.toggle' },
    { key: 'cmd+]', command: 'inspector.toggle' },
    { key: 'cmd+,', command: 'settings.open' },
];
