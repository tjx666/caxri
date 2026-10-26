import { agentChatChanges } from './agent-chat-changes';
import { agentChatComposer } from './agent-chat-composer';
import { agentChatContext } from './agent-chat-context';
import { agentChatPane } from './agent-chat-pane';
import { agentChatTimeline } from './agent-chat-timeline';
import { agentChatUsageLimit } from './agent-chat-usage-limit';

/**
 * Agent Chat strings, split by area so each module stays reviewable.
 */
export const agentChat = {
    ...agentChatComposer,
    ...agentChatTimeline,
    ...agentChatChanges,
    ...agentChatPane,
    ...agentChatContext,
    ...agentChatUsageLimit,
} as const;
