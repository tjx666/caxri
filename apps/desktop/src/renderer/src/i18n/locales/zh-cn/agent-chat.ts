import type { TranslatedNamespace } from '@caxri/protocol';

import type { agentChat as source } from '../en/agent-chat';
import { agentChatChanges } from './agent-chat-changes';
import { agentChatComposer } from './agent-chat-composer';
import { agentChatContext } from './agent-chat-context';
import { agentChatPane } from './agent-chat-pane';
import { agentChatTimeline } from './agent-chat-timeline';

export const agentChat: TranslatedNamespace<typeof source> = {
    ...agentChatComposer,
    ...agentChatTimeline,
    ...agentChatChanges,
    ...agentChatPane,
    ...agentChatContext,
};
