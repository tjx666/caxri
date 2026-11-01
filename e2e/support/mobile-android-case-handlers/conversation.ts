import { test } from '../fixtures';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileConversationCase } from '../mobile-conversation-cases';

export const handlers = {
    'MOB-CONV-01': (environment, artifacts) => {
        test.setTimeout(420_000);
        return executeMobileConversationCase(environment, artifacts);
    },
    'MOB-CONV-02': executeMobileConversationCase,
    'MOB-CONV-03': executeMobileConversationCase,
    'MOB-CONV-04': executeMobileConversationCase,
    'MOB-CONV-05': executeMobileConversationCase,
    'MOB-TIMELINE-01': executeMobileConversationCase,
    'MOB-UI-04': executeMobileConversationCase,
} satisfies Record<string, MobileAndroidCaseHandler>;
