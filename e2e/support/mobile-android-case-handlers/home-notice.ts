import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileHomeNoticeSettleScenario } from '../mobile-home-notice-scenario';

export const handlers = {
    'MOB-SESSION-NOTICE-SETTLE-01': executeMobileHomeNoticeSettleScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
