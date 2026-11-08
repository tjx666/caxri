import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileTrackerCardWidthScenario } from '../mobile-tracker-card-width-scenario';

export const handlers = {
    'MOB-CHAT-TRACKER-CARD-01': executeMobileTrackerCardWidthScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
