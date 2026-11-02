import {
    executeMobileChatUsageGuardHandoffScenario,
    executeMobileChatUsageGuardOfflineScenario,
    executeMobileChatUsageLimitContinueScenario,
} from '../mobile-agent-chat-usage-actions-scenarios';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-USAGE-ACT-01': executeMobileChatUsageLimitContinueScenario,
    'MOB-CHAT-USAGE-ACT-02': executeMobileChatUsageGuardHandoffScenario,
    'MOB-CHAT-USAGE-ACT-03': executeMobileChatUsageGuardOfflineScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
