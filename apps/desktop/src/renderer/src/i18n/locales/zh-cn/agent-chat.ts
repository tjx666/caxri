import type { TranslatedNamespace } from '@desktop-shared/i18n/translated-namespace';

import type { agentChat as source } from '../en/agent-chat';
import { agentChatChanges } from './agent-chat-changes';
import { agentChatComposer } from './agent-chat-composer';
import { agentChatPane } from './agent-chat-pane';
import { agentChatRequests } from './agent-chat-requests';
import { agentChatTimeline } from './agent-chat-timeline';

export const agentChat: TranslatedNamespace<typeof source> = {
    ...agentChatComposer,
    ...agentChatTimeline,
    ...agentChatChanges,
    ...agentChatPane,
    ...agentChatRequests,
};
