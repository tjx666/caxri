import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileMotionScenario } from '../mobile-motion-scenarios';

export const handlers = {
    'MOB-MOTION-01': executeMobileMotionScenario,
    'MOB-MOTION-03': executeMobileMotionScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
