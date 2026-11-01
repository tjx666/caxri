import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';
import { executeMobileSessionArchiveUndoScenario } from '../mobile-session-archive-undo-scenario';

export const handlers = {
    'MOB-SESSION-ARCHIVE-UNDO-01': executeMobileSessionArchiveUndoScenario,
} satisfies Record<string, MobileChatCaseHandler>;
