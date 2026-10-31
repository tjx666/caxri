import { executeMobileChatAwayRecapScenario } from '../mobile-agent-chat-away-recap-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-AWAY-RECAP-01': executeMobileChatAwayRecapScenario,
} satisfies Record<string, MobileChatCaseHandler>;
