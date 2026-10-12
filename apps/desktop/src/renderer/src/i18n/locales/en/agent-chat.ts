import { agentChatChanges } from './agent-chat-changes';
import { agentChatComposer } from './agent-chat-composer';
import { agentChatPane } from './agent-chat-pane';
import { agentChatRequests } from './agent-chat-requests';
import { agentChatTimeline } from './agent-chat-timeline';

/**
 * Agent Chat strings, split by area so each module stays reviewable.
 */
export const agentChat = {
    ...agentChatComposer,
    ...agentChatTimeline,
    ...agentChatChanges,
    ...agentChatPane,
    ...agentChatRequests,
} as const;
