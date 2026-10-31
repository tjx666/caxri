import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';
import { executeMobileStatusTreeMergeScenario } from '../mobile-pull-request-scenario';

export const handlers = {
    'MOB-CHAT-STATUS-TREE-MERGE-01': executeMobileStatusTreeMergeScenario,
} satisfies Record<string, MobileChatCaseHandler>;
