import { executeMobileChatFileScenario } from '../mobile-agent-chat-file-scenario';
import {
    executeMobileChatVideoScenario,
    executeMobileChatVideoUnavailableScenario,
} from '../mobile-agent-chat-video-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-FILE-01': executeMobileChatFileScenario,
    'MOB-CHAT-VIDEO-01': executeMobileChatVideoScenario,
    'MOB-CHAT-VIDEO-02': executeMobileChatVideoUnavailableScenario,
} satisfies Record<string, MobileChatCaseHandler>;
