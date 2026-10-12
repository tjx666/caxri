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
        /**
         * One command for both: a Shell starts again, and an Agent Terminal restarts the Agent and resumes its
         * conversation, which its menus and recovery row call "Restart Agent". The catalog title is static because the
         * native menu is built from it once, so the Agent wording reaches the palette through the description and
         * keywords.
         */
        description:
            'Restart the active Shell, or restart the active Agent and resume its conversation (Restart Agent)',
        keywords: ['restart agent', 'resume agent', 'reload agent'],
        nativeMenu: { menu: 'terminal', group: 0, order: 2 },
    },
    {
        id: 'terminal.startNewAgentSession',
        /**
         * "Conversation", not "Agent Session": a bare "session" in a title collides with Caxri's own Session, and this
         * command never touches one. The id keeps its old name so saved keybindings still resolve.
         */
        title: 'Start New Conversation',
        category: 'Terminal',
        description:
            'Restart the active Agent with a new conversation instead of resuming the current one',
        keywords: ['new agent session', 'fresh conversation', 'new chat', 'reset agent'],
        nativeMenu: { menu: 'terminal', group: 0, order: 3 },
    },
    {
        id: 'terminal.switchAgentSurface',
        /**
         * Names both directions because the title is static: the native menu is built from the catalog once, so it
         * cannot follow the active tab the way the tab menu's "Open as Chat" or "Open as Terminal" entry does. The tab
         * rail's Terminal | Chat toggle carries the same accessible name.
         */
        title: 'Open as Terminal or Chat',
        category: 'Terminal',
        description:
            'Reopen the active Agent as a Chat, or a Chat as a Terminal, continuing its conversation',
        keywords: [
            'open as chat',
            'open as terminal',
            'switch agent',
            'chat view',
            'terminal view',
            'toggle chat',
        ],
        nativeMenu: { menu: 'terminal', group: 0, order: 4 },
    },
    {
        id: 'terminal.showAgentStatus',
        title: 'Show Agent Status',
        category: 'Terminal',
        description: "Open the active Agent's output speed and its provider's service status",
        keywords: ['tok/s', 'tokens per second', 'speed', 'throughput', 'api status', 'outage'],
    },
    {
        id: 'terminal.close',
        title: 'Close Terminal',
        category: 'Terminal',
        description: 'Close the active Terminal',
        nativeMenu: { menu: 'terminal', group: 0, order: 5 },
    },
];
