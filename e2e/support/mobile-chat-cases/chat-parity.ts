import { executeMobileChatBareLinkScenario } from '../mobile-agent-chat-bare-link-scenario';
import {
    executeMobileChatFileChipScenario,
    executeMobileChatFileLinkScenario,
    executeMobileChatMentionFileScenario,
    executeMobileChatMentionSessionScenario,
    executeMobileChatSlashScenario,
} from '../mobile-agent-chat-parity-scenario';
import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';

export const handlers = {
    'MOB-CHAT-FILE-CHIP-01': executeMobileChatFileChipScenario,
    'MOB-CHAT-FILE-LINK-01': executeMobileChatFileLinkScenario,
    'MOB-CHAT-BARE-LINK-01': executeMobileChatBareLinkScenario,
    'MOB-CHAT-SLASH-01': executeMobileChatSlashScenario,
    'MOB-CHAT-MENTION-FILE-01': executeMobileChatMentionFileScenario,
    'MOB-CHAT-MENTION-SESSION-01': executeMobileChatMentionSessionScenario,
} satisfies Record<string, MobileChatCaseHandler>;
