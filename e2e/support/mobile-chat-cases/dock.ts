import { executeMobileChatDockFoldScenario } from '../mobile-agent-chat-dock-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-DOCK-FOLD-01': executeMobileChatDockFoldScenario,
} satisfies Record<string, MobileChatCaseHandler>;
