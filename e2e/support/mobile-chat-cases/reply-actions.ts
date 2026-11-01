import { executeMobileChatReplyActionsScenario } from '../mobile-agent-chat-reply-actions-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-REPLY-ACTIONS-01': executeMobileChatReplyActionsScenario,
} satisfies Record<string, MobileChatCaseHandler>;
