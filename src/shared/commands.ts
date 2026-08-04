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
    { id: 'theme.openSettings', title: 'Open Settings', category: 'Preferences' },
    { id: 'commandPalette.open', title: 'Open Command Palette', category: 'View' },
    { id: 'diagnostics.export', title: 'Export Diagnostics', category: 'Help' },
];

export function getCommandDefinition(id: string): CommandDefinition {
    const definition = commandDefinitions.find((command) => command.id === id);
    if (!definition) throw new Error(`Unknown command: ${id}`);
    return definition;
}
