import type { MobileChatCaseHandler } from '../mobile-chat-case-registry';
import {
    executeMobileStatusTreeMergeScenario,
    executeMobileStatusTreeResolveScenario,
} from '../mobile-pull-request-scenario';

export const handlers = {
    'MOB-CHAT-STATUS-TREE-MERGE-01': executeMobileStatusTreeMergeScenario,
    'MOB-CHAT-STATUS-TREE-RESOLVE-01': executeMobileStatusTreeResolveScenario,
} satisfies Record<string, MobileChatCaseHandler>;
