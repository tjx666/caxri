import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileNestedSessionsScenario } from '../mobile-nested-sessions-scenario';
import { executeMobileSessionListMotionScenario } from '../mobile-session-list-motion-scenario';

export const handlers = {
    'MOB-SESSION-LIST-NESTED-01': executeMobileNestedSessionsScenario,
    'MOB-SESSION-LIST-MOTION-01': executeMobileSessionListMotionScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
