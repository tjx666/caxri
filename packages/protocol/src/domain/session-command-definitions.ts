import type { CommandDefinition } from './command-catalog.js';

/**
 * Commands that act on Sessions in the Primary Side Bar: creating, renaming, archiving, detaching, selecting, and
 * navigating them, in their command catalog order.
 */
export const sessionCommandDefinitions: CommandDefinition[] = [
    {
        id: 'session.create',
        title: 'New Session',
        category: 'Session',
        description: 'Create a Session in the selected Project',
        nativeMenu: { menu: 'session', group: 0, order: 0 },
    },
    {
        id: 'session.rename',
        title: 'Rename Session',
        category: 'Session',
        description: 'Rename the selected Session in the Primary Side Bar',
        nativeMenu: { menu: 'session', group: 0, order: 1 },
    },
    {
        id: 'session.renameWithAi',
        title: 'Rename Session with AI',
        category: 'Session',
        description:
            'Suggest a name for the selected Session from its Agent conversation, ready to accept or edit',
        keywords: ['suggest title', 'ai name', 'generate name'],
    },
    {
        id: 'session.delete',
        title: 'Delete Session',
        category: 'Session',
        description: 'Delete the selected Session and its Terminals without touching files on disk',
        nativeMenu: { menu: 'session', group: 0, order: 2 },
    },
    {
        id: 'session.archive',
        title: 'Archive Session',
        category: 'Session',
        description: 'Move the selected Session out of the sidebar and park its Terminals',
        nativeMenu: { menu: 'session', group: 0, order: 3 },
    },
    {
        id: 'session.compactWarm',
        title: 'Compact Recently Idle Sessions',
        category: 'Session',
        description:
            'Compact the Agent conversations of Sessions that went idle recently, while compacting them is still cheap',
        keywords: ['warm cache', 'prompt cache', 'compact', 'context'],
    },
    {
        id: 'session.detach',
        title: 'Detach Agent',
        category: 'Session',
        description:
            'Stop the selected Session’s Agent Terminals so another client can resume the same conversation',
        when: 'sessionHasLiveAgent',
        nativeMenu: { menu: 'session', group: 3, order: 0 },
    },
    {
        id: 'session.resume',
        title: 'Resume Agent',
        category: 'Session',
        description:
            'Relaunch the selected Session’s detached Agent Terminals and resume their conversations',
        when: 'sessionHasDetachedAgent',
        nativeMenu: { menu: 'session', group: 3, order: 1 },
    },
    {
        id: 'session.openPullRequest',
        title: 'Open Pull Request',
        category: 'Session',
        description: 'Open the selected Session’s pull request on GitHub in the browser',
        keywords: ['pr', 'github'],
        when: 'sessionHasPullRequest',
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
        id: 'session.focusNextAttention',
        title: 'Go to Next Session Needing Attention',
        category: 'Session',
        description: 'Select the next Session with an event you have not opened yet',
        keywords: ['attention', 'unread', 'waiting', 'inbox'],
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
        id: 'session.searchContent',
        title: 'Search Session Content',
        category: 'Session',
        description: 'Find active and archived Sessions by user and assistant messages',
        keywords: ['conversation', 'transcript', 'history'],
        nativeMenu: { menu: 'session', group: 4, order: 1 },
    },
    {
        id: 'session.openArchived',
        title: 'Show Archived Sessions',
        category: 'Session',
        description: 'Open the Archived Sessions manager to restore or delete a parked Session',
        keywords: ['archive', 'archived', 'restore', 'unarchive'],
        nativeMenu: { menu: 'session', group: 4, order: 0 },
    },
];
