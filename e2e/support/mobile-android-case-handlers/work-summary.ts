import { executeMobileChatSingleWorkScenario } from '../mobile-agent-chat-single-work-scenario';
import { executeMobileChatSteerReplyScenario } from '../mobile-agent-chat-steer-reply-scenario';
import { executeMobileChatWorkGroupFoldScenario } from '../mobile-agent-chat-work-group-fold-scenario';
import { executeMobileChatWorkGroupTitleScenario } from '../mobile-agent-chat-work-group-title-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-SINGLE-WORK-01': executeMobileChatSingleWorkScenario,
    'MOB-CHAT-STEER-REPLY-01': executeMobileChatSteerReplyScenario,
    'MOB-CHAT-WORK-GROUP-FOLD-01': executeMobileChatWorkGroupFoldScenario,
    'MOB-CHAT-WORK-GROUP-TITLE-01': executeMobileChatWorkGroupTitleScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
