import type { CommandDefinition } from './command-catalog.js';

/**
 * Commands that act on the active Terminal: creating, reading, navigating, relaunching, and closing it, in their
 * command catalog order.
 */
export const terminalCommandDefinitions: CommandDefinition[] = [
    {
        id: 'terminal.new',
        title: 'New Terminal',
        category: 'Terminal',
        description: 'Create a Terminal in the current Session',
        nativeMenu: { menu: 'terminal', group: 0, order: 0 },
    },
    {
        id: 'terminal.newInSplit',
        title: 'New Terminal in Split Pane',
        category: 'Terminal',
        description: 'Create a Terminal in a new pane to the right of the active pane',
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
        id: 'terminal.switchAgentSurface',
        title: 'Switch Agent Between Terminal and Chat',
        category: 'Terminal',
        description:
            'Reopen the active Agent as a Chat, or a Chat as a Terminal, continuing its conversation',
        keywords: ['chat view', 'terminal view', 'toggle chat'],
    },
    {
        id: 'terminal.close',
        title: 'Close Terminal',
        category: 'Terminal',
        description: 'Close the active Terminal',
        nativeMenu: { menu: 'terminal', group: 0, order: 4 },
    },
];
