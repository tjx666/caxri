import { executeMobileChatReplyActionsScenario } from '../mobile-agent-chat-reply-actions-scenario';
import { executeMobileChatSourcesReturnScenario } from '../mobile-agent-chat-sources-return-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-REPLY-ACTIONS-01': executeMobileChatReplyActionsScenario,
    'MOB-CHAT-SOURCES-RETURN-01': executeMobileChatSourcesReturnScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
