import { executeMobileChatReplyActionsScenario } from '../mobile-agent-chat-reply-actions-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-REPLY-ACTIONS-01': executeMobileChatReplyActionsScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
