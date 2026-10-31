import { executeMobileChatFileScenario } from '../mobile-agent-chat-file-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-FILE-01': executeMobileChatFileScenario,
} satisfies Record<string, MobileChatCaseHandler>;
