import { executeMobileDelegationNoticeScenario } from '../mobile-agent-chat-delegation-notice-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-DELEGATION-NOTICE-01': executeMobileDelegationNoticeScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
