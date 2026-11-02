import { executeMobileChatSingleWorkScenario } from '../mobile-agent-chat-single-work-scenario';
import { executeMobileChatWorkGroupOpenScenario } from '../mobile-agent-chat-work-group-open-scenario';
import { executeMobileChatWorkGroupTitleScenario } from '../mobile-agent-chat-work-group-title-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-SINGLE-WORK-01': executeMobileChatSingleWorkScenario,
    'MOB-CHAT-WORK-GROUP-OPEN-01': executeMobileChatWorkGroupOpenScenario,
    'MOB-CHAT-WORK-GROUP-TITLE-01': executeMobileChatWorkGroupTitleScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
