import { executeMobileChatSingleWorkScenario } from '../mobile-agent-chat-single-work-scenario';
import { executeMobileChatWorkGroupTitleScenario } from '../mobile-agent-chat-work-group-title-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-SINGLE-WORK-01': executeMobileChatSingleWorkScenario,
    'MOB-CHAT-WORK-GROUP-TITLE-01': executeMobileChatWorkGroupTitleScenario,
} satisfies Record<string, MobileChatCaseHandler>;
