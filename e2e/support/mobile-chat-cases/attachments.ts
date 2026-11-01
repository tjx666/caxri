import { executeMobileChatFileScenario } from '../mobile-agent-chat-file-scenario';
import { executeMobileChatImagePendingScenario } from '../mobile-agent-chat-image-pending-scenario';
import {
    executeMobileChatVideoScenario,
    executeMobileChatVideoUnavailableScenario,
} from '../mobile-agent-chat-video-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-FILE-01': executeMobileChatFileScenario,
    'MOB-CHAT-IMAGE-PENDING-01': executeMobileChatImagePendingScenario,
    'MOB-CHAT-VIDEO-01': executeMobileChatVideoScenario,
    'MOB-CHAT-VIDEO-02': executeMobileChatVideoUnavailableScenario,
} satisfies Record<string, MobileChatCaseHandler>;
