import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileIdleCapScenario } from '../mobile-idle-cap-scenario';
import { executeMobileNestedSessionsScenario } from '../mobile-nested-sessions-scenario';
import { executeMobileSessionListMotionScenario } from '../mobile-session-list-motion-scenario';

export const handlers = {
    'MOB-SESSION-LIST-NESTED-01': executeMobileNestedSessionsScenario,
    'MOB-SESSION-LIST-IDLE-CAP-01': executeMobileIdleCapScenario,
    'MOB-SESSION-LIST-MOTION-01': executeMobileSessionListMotionScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
