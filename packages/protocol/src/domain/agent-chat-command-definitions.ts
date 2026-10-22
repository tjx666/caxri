import type { CommandDefinition } from './command-catalog.js';

/**
 * Commands that drive the active Chat's composer: its model, permission, plan mode, and side chat controls, in their
 * command catalog order, plus the one command that reaches the waiting popup.
 */
export const agentChatCommandDefinitions: CommandDefinition[] = [
    {
        id: 'agentChat.changeModel',
        title: 'Change Model…',
        category: 'Chat',
        description: "Open the active Chat's model and reasoning effort picker",
        keywords: ['model', 'switch model', 'reasoning effort', 'effort', 'thinking'],
        when: 'agentChatModels',
    },
    {
        id: 'agentChat.changePermissionMode',
        title: 'Change Permission Mode…',
        category: 'Chat',
        description: "Open the active Chat's permission level menu",
        keywords: ['permissions', 'approval', 'sandbox', 'full access', 'read only', 'mode'],
        when: 'agentChatPermissionModes',
    },
    {
        id: 'agentChat.togglePlanMode',
        title: 'Toggle Plan Mode',
        category: 'Chat',
        description: 'Turn plan mode on or off for the active Chat',
        keywords: ['plan', 'planning', 'plan mode'],
        when: 'agentChatPlanMode',
    },
    {
        id: 'agentChat.openSideChat',
        title: 'Open Side Chat',
        category: 'Chat',
        description:
            "Ask a quick question from the active Chat's context beside the conversation, without adding it to the conversation",
        keywords: ['btw', 'side question', 'aside', 'side chat'],
        when: 'agentChatSideChat',
    },
    {
        id: 'agentChat.focusWaitingRequest',
        title: 'Focus Waiting Request',
        category: 'Chat',
        description:
            "Move keyboard focus into the waiting popup's question or approval, unfolding it first",
        keywords: ['waiting', 'pending', 'question', 'approval', 'popup'],
        when: 'agentChatWaiting',
    },
];
