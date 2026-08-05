import type { Keybinding } from './types';

export interface CommandDefinition {
    id: string;
    title: string;
    category: string;
}

/** One command catalog supplies the palette, shortcuts, native menus, and command-backed buttons. */
export const commandDefinitions: CommandDefinition[] = [
    { id: 'project.create', title: 'Add Project', category: 'Project' },
    { id: 'project.delete', title: 'Remove Project', category: 'Project' },
    { id: 'session.create', title: 'New Session', category: 'Session' },
    { id: 'session.delete', title: 'Delete Session', category: 'Session' },
    { id: 'session.selectNext', title: 'Select Next Session', category: 'Session' },
    { id: 'session.selectPrevious', title: 'Select Previous Session', category: 'Session' },
    { id: 'terminal.new', title: 'New Terminal', category: 'Terminal' },
    { id: 'terminal.clear', title: 'Clear Terminal', category: 'Terminal' },
    { id: 'terminal.restart', title: 'Restart Terminal', category: 'Terminal' },
    { id: 'terminal.close', title: 'Close Terminal', category: 'Terminal' },
    { id: 'editor.save', title: 'Save File', category: 'Editor' },
    { id: 'inspector.showFiles', title: 'Show Files', category: 'Inspector' },
    { id: 'inspector.showGit', title: 'Show Git', category: 'Inspector' },
    { id: 'inspector.showInfo', title: 'Show Terminal Info', category: 'Inspector' },
    { id: 'inspector.toggle', title: 'Toggle Inspector', category: 'Inspector' },
    { id: 'settings.open', title: 'Open Settings', category: 'Preferences' },
    { id: 'commandPalette.open', title: 'Open Command Palette', category: 'View' },
    { id: 'diagnostics.export', title: 'Export Diagnostics', category: 'Help' },
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
    { key: 'cmd+w', command: 'terminal.close' },
    { key: 'cmd+s', command: 'editor.save' },
    { key: 'cmd+1', command: 'inspector.showFiles' },
    { key: 'cmd+2', command: 'inspector.showGit' },
    { key: 'cmd+3', command: 'inspector.showInfo' },
    { key: 'cmd+,', command: 'settings.open' },
];
