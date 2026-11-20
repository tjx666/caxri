import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileHomeNoticeSettleScenario } from '../mobile-home-notice-scenario';
import { executeMobileHomeReconnectNoticeScenario } from '../mobile-home-reconnect-notice-scenario';

export const handlers = {
    'MOB-SESSION-NOTICE-SETTLE-01': executeMobileHomeNoticeSettleScenario,
    'MOB-SESSION-NOTICE-RECONNECT-01': executeMobileHomeReconnectNoticeScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
