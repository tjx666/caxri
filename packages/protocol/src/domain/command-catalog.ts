import type { DefaultKeybindingChange } from '../configuration/config-files.js';
import {
    filesCoreCommandDefinitions,
    filesCoreKeybindings,
} from '../registry/core-contributions.js';
import type { CommandId } from './commands.js';
import type { Keybinding } from './domain.js';

export interface CommandDefinition {
    id: CommandId;
    title: string;
    category: string;
    description: string;
    /**
     * Search-only aliases that preserve familiar language without leaking it back into visible command copy.
     */
    keywords?: readonly string[];
    /**
     * Commands that require configured arguments remain available to keybindings but stay out of the palette, whose
     * invocation path cannot supply those arguments.
     */
    requiresArguments?: boolean;
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

/**
 * One command catalog supplies the palette, shortcuts, native menus, and command-backed buttons.
 */
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
        title: 'Delete Project',
        category: 'Project',
        description: 'Delete the selected Project from Caxri without touching its files',
        nativeMenu: { menu: 'project', group: 0, order: 1 },
    },
    {
        id: 'project.openInEditor',
        title: 'Open Project in External Editor',
        category: 'Project',
        description: 'Open the selected Project root in the configured external editor',
        nativeMenu: { menu: 'project', group: 1, order: 0 },
    },
    {
        id: 'project.customizeIcon',
        title: 'Customize Project Icon…',
        category: 'Project',
        description: 'Choose a controlled icon and color for the selected Project',
        nativeMenu: { menu: 'project', group: 1, order: 1 },
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
        title: 'Delete Session',
        category: 'Session',
        description: 'Delete the selected Session and its Terminals without touching files on disk',
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
        id: 'session.switchMru',
        title: 'Switch to Recently Used Session',
        category: 'Session',
        description: 'Switch between active Sessions in recently used order',
    },
    {
        id: 'session.navigateBack',
        title: 'Go Back',
        category: 'Session',
        description: 'Return to the Session you were viewing before this one',
        nativeMenu: { menu: 'session', group: 2, order: 0 },
    },
    {
        id: 'session.navigateForward',
        title: 'Go Forward',
        category: 'Session',
        description: 'Move forward again through the Sessions you stepped back from',
        nativeMenu: { menu: 'session', group: 2, order: 1 },
    },
    {
        id: 'agentActions.open',
        title: 'Run Agent Command or Skill…',
        category: 'Agent',
        description: 'Search Agent commands and skills for the active Agent Terminal',
        keywords: ['action', 'actions', 'command', 'commands', 'skill', 'skills', 'slash'],
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
        id: 'terminal.copy',
        title: 'Copy Selection',
        category: 'Terminal',
        description: 'Copy the active Terminal selection to the clipboard',
        nativeMenu: { menu: 'terminal', group: 1, order: 0 },
    },
    {
        id: 'terminal.find',
        title: 'Find in Terminal',
        category: 'Terminal',
        description: 'Search the active Terminal buffer',
        nativeMenu: { menu: 'terminal', group: 1, order: 1 },
    },
    {
        id: 'terminal.openDetectedLink',
        title: 'Open Detected Link…',
        category: 'Terminal',
        description: 'Search and open links detected in the Terminal without using the pointer',
        nativeMenu: { menu: 'terminal', group: 1, order: 4 },
    },
    {
        id: 'terminal.previousCommand',
        title: 'Go to Previous Terminal Command',
        category: 'Terminal',
        description: 'Scroll the active Terminal to the previous command boundary',
        nativeMenu: { menu: 'terminal', group: 1, order: 2 },
    },
    {
        id: 'terminal.nextCommand',
        title: 'Go to Next Terminal Command',
        category: 'Terminal',
        description: 'Scroll the active Terminal to the next command boundary',
        nativeMenu: { menu: 'terminal', group: 1, order: 3 },
    },
    {
        id: 'workbench.action.terminal.sendSequence',
        title: 'Send Sequence',
        category: 'Terminal',
        description: 'Send configured text directly to the active Terminal',
        requiresArguments: true,
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
        id: 'workbench.nextTab',
        title: 'Show Next Tab',
        category: 'View',
        description: 'Activate the next Terminal or file tab',
        nativeMenu: { menu: 'window', group: 1, order: 0 },
    },
    {
        id: 'workbench.previousTab',
        title: 'Show Previous Tab',
        category: 'View',
        description: 'Activate the previous Terminal or file tab',
        nativeMenu: { menu: 'window', group: 1, order: 1 },
    },
    {
        id: 'editor.save',
        title: 'Save File',
        category: 'Editor',
        description: 'Save the active file',
    },
    {
        id: 'workbench.splitLeft',
        title: 'Split Left',
        category: 'Workbench',
        description: 'Split the active tab into a new pane to the left',
    },
    {
        id: 'workbench.splitRight',
        title: 'Split Right',
        category: 'Workbench',
        description: 'Split the active tab into a new pane to the right',
    },
    {
        id: 'workbench.splitUp',
        title: 'Split Up',
        category: 'Workbench',
        description: 'Split the active tab into a new pane above',
    },
    {
        id: 'workbench.splitDown',
        title: 'Split Down',
        category: 'Workbench',
        description: 'Split the active tab into a new pane below',
    },
    {
        id: 'workbench.focusPaneLeft',
        title: 'Focus Pane to the Left',
        category: 'Workbench',
        description: 'Move keyboard focus to the pane to the left of the current one',
    },
    {
        id: 'workbench.focusPaneRight',
        title: 'Focus Pane to the Right',
        category: 'Workbench',
        description: 'Move keyboard focus to the pane to the right of the current one',
    },
    {
        id: 'workbench.focusPaneUp',
        title: 'Focus Pane Above',
        category: 'Workbench',
        description: 'Move keyboard focus to the pane above the current one',
    },
    {
        id: 'workbench.focusPaneDown',
        title: 'Focus Pane Below',
        category: 'Workbench',
        description: 'Move keyboard focus to the pane below the current one',
    },
    {
        id: 'workbench.moveActiveTerminalToNewSession',
        title: 'Move to New Session',
        category: 'Workbench',
        description: "Move the active Terminal into a new Session in the Terminal's Project",
    },
    ...filesCoreCommandDefinitions,
    {
        id: 'secondarySidebar.showGit',
        title: 'Show Git',
        category: 'Secondary Side Bar',
        description: 'Show Source Control in the Secondary Side Bar',
    },
    {
        id: 'secondarySidebar.showStatus',
        title: 'Show Status',
        category: 'Secondary Side Bar',
        description: 'Show Project Status in the Secondary Side Bar',
    },
    {
        id: 'secondarySidebar.toggle',
        title: 'Toggle Secondary Side Bar',
        category: 'Secondary Side Bar',
        description: 'Show or hide the Secondary Side Bar',
        nativeMenu: { menu: 'view', group: 0, order: 2 },
    },
    {
        id: 'panel.showLogs',
        title: 'Show Logs',
        category: 'Panel',
        description: 'Show Logs in the Panel',
    },
    {
        id: 'panel.showInfo',
        title: 'Show Info',
        category: 'Panel',
        description: 'Show Info in the Panel',
    },
    {
        id: 'panel.toggle',
        title: 'Toggle Panel',
        category: 'Panel',
        description: 'Show or hide the Panel',
        nativeMenu: { menu: 'view', group: 0, order: 3 },
    },
    {
        id: 'primarySidebar.toggle',
        title: 'Toggle Primary Side Bar',
        category: 'View',
        description: 'Show or hide the Primary Side Bar',
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
        id: 'settings.openKeybindings',
        title: 'Open Keyboard Shortcuts',
        category: 'Preferences',
        description: 'Edit Caxri keyboard shortcuts',
    },
    {
        id: 'settings.manageTrustedDomains',
        title: 'Manage Trusted Domains',
        category: 'Preferences',
        description: 'Review which external-link origins Caxri opens without confirmation',
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

/**
 * Returns command-backed native-menu groups in their declared presentation order.
 */
export function getNativeMenuCommandGroups(menu: NativeMenuId): CommandDefinition[][] {
    const placed = commandDefinitions
        .filter((command) => command.nativeMenu?.menu === menu)
        .toSorted((a, b) => {
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

/**
 * Default keyboard shortcuts, seeded into `keybindings.jsonc` on first run.
 */
export const defaultKeybindings: Keybinding[] = [
    /**
     * The current path browser owns the familiar macOS quick-open chord. A future workspace-wide fuzzy opener must make
     * an explicit product decision instead of reserving `Cmd+P` while no such command exists.
     */
    { key: 'cmd+p', command: 'pathBrowser.open' },
    { key: 'cmd+shift+p', command: 'commandPalette.open' },
    { key: 'cmd+shift+a', command: 'agentActions.open' },
    /**
     * `Cmd+O` matches the macOS/VS Code "Open…" convention: adding a Project is opening a local folder.
     */
    { key: 'cmd+o', command: 'project.create' },
    { key: 'cmd+t', command: 'terminal.new' },
    { key: 'cmd+k', command: 'terminal.clear' },
    { key: 'cmd+c', command: 'terminal.copy' },
    { key: 'cmd+f', command: 'terminal.find' },
    {
        key: 'cmd+shift+o',
        command: 'terminal.openDetectedLink',
        when: 'terminalFocus',
    },
    { key: 'ctrl+tab', command: 'workbench.nextTab' },
    { key: 'ctrl+shift+tab', command: 'workbench.previousTab' },
    /**
     * `Cmd+Backquote` follows the macOS current-app window switching convention for Caxri's closest equivalent context:
     * Sessions inside its single window. `Ctrl+Tab` remains dedicated to Workbench tabs.
     */
    { key: 'cmd+`', command: 'session.switchMru' },
    /**
     * VS Code's `Ctrl+-` / `Ctrl+Shift+-` history chords are unavailable because these commands must fire while a
     * Terminal owns focus, where they would shadow the shell's own `Ctrl+_`.
     */
    { key: 'ctrl+alt+arrowleft', command: 'session.navigateBack' },
    { key: 'ctrl+alt+arrowright', command: 'session.navigateForward' },
    { key: 'cmd+shift+arrowup', command: 'terminal.previousCommand' },
    { key: 'cmd+shift+arrowdown', command: 'terminal.nextCommand' },
    { key: 'cmd+shift+r', command: 'terminal.restart' },
    /**
     * `Cmd+\` is the iTerm2/Terminal.app convention for splitting a pane; only the rightward direction gets a default
     * chord, the same way `terminal.new`'s `Cmd+T` leaves the other three split directions palette-only.
     */
    { key: 'cmd+\\', command: 'workbench.splitRight' },
    /**
     * `Cmd+Option+Arrow` moves keyboard focus between panes, iTerm2 style. `Cmd+K` chords already belong to Terminal
     * Clear (`terminal.clear`) and `Cmd+<number>` is taken by the Secondary Side Bar/Panel view-container shortcuts, so
     * neither of VS Code's own pane-navigation families is free here. `allowInEditable` lets the chord reach through a
     * focused xterm — split view is otherwise mouse-only while a Terminal owns focus.
     */
    { key: 'cmd+alt+arrowleft', command: 'workbench.focusPaneLeft' },
    { key: 'cmd+alt+arrowright', command: 'workbench.focusPaneRight' },
    { key: 'cmd+alt+arrowup', command: 'workbench.focusPaneUp' },
    { key: 'cmd+alt+arrowdown', command: 'workbench.focusPaneDown' },
    { key: 'cmd+w', command: 'workbench.closeActiveTab' },
    { key: 'cmd+s', command: 'editor.save' },
    ...filesCoreKeybindings,
    { key: 'cmd+2', command: 'secondarySidebar.showGit' },
    { key: 'cmd+3', command: 'secondarySidebar.showStatus' },
    { key: 'cmd+shift+1', command: 'panel.showLogs' },
    { key: 'cmd+shift+2', command: 'panel.showInfo' },
    { key: 'cmd+[', command: 'primarySidebar.toggle' },
    { key: 'cmd+]', command: 'secondarySidebar.toggle' },
    /**
     * `Cmd+J` matches VS Code's Toggle Panel chord, which this region is modeled on.
     */
    { key: 'cmd+j', command: 'panel.toggle' },
    { key: 'cmd+,', command: 'settings.open' },
];

/**
 * Reviewed changes to defaults that existing keybinding files can adopt without overwriting custom choices.
 */
export const defaultKeybindingChanges = [
    {
        type: 'replace',
        previous: { key: 'alt+p', command: 'pathBrowser.open' },
        current: { key: 'cmd+p', command: 'pathBrowser.open' },
    },
    {
        type: 'replace',
        previous: { key: 'ctrl+alt+tab', command: 'session.switchMru' },
        current: { key: 'cmd+`', command: 'session.switchMru' },
    },
    {
        type: 'add',
        binding: { key: 'cmd+3', command: 'secondarySidebar.showStatus' },
    },
] satisfies readonly DefaultKeybindingChange[];
