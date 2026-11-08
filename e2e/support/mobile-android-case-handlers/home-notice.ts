import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileHomeNoticeSettleScenario } from '../mobile-home-notice-scenario';
import { executeMobileHomeReconnectNoticeScenario } from '../mobile-home-reconnect-notice-scenario';
import { executeMobileHomeTruncatedIslandScenario } from '../mobile-home-truncated-island-scenario';

export const handlers = {
    'MOB-SESSION-NOTICE-SETTLE-01': executeMobileHomeNoticeSettleScenario,
    'MOB-SESSION-NOTICE-RECONNECT-01': executeMobileHomeReconnectNoticeScenario,
    'MOB-SESSION-NOTICE-ISLAND-01': executeMobileHomeTruncatedIslandScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
