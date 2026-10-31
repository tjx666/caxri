import { executeMobileChatSingleWorkScenario } from '../mobile-agent-chat-single-work-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-SINGLE-WORK-01': executeMobileChatSingleWorkScenario,
} satisfies Record<string, MobileChatCaseHandler>;
