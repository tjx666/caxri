import { executeMobileChatBackScenario } from '../mobile-agent-chat-back-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-BACK-01': executeMobileChatBackScenario,
} satisfies Record<string, MobileChatCaseHandler>;
