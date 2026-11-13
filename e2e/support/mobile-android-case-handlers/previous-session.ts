import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobilePreviousSessionScenario } from '../mobile-previous-session-scenario';

export const handlers = {
    'MOB-SESSION-PREVIOUS-01': executeMobilePreviousSessionScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
