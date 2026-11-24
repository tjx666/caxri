import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileMemoryCardScenario } from '../mobile-memory-card-scenario';
import { executeMobileTrackerCardWidthScenario } from '../mobile-tracker-card-width-scenario';

export const handlers = {
    'MOB-CHAT-TRACKER-CARD-01': executeMobileTrackerCardWidthScenario,
    'MOB-CHAT-MEMORY-CARD-01': executeMobileMemoryCardScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
