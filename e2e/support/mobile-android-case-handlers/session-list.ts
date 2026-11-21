import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileIdleCapScenario } from '../mobile-idle-cap-scenario';
import { executeMobileNestedSessionsScenario } from '../mobile-nested-sessions-scenario';
import { executeMobileProjectSwitchMotionScenario } from '../mobile-project-switch-motion-scenario';
import { executeMobileSessionListMotionScenario } from '../mobile-session-list-motion-scenario';
import {
    executeMobileProjectChipsScenario,
    executeMobileSessionPagingScenario,
} from '../mobile-session-paging-scenario';

export const handlers = {
    'MOB-SESSION-LIST-NESTED-01': executeMobileNestedSessionsScenario,
    'MOB-SESSION-LIST-IDLE-CAP-01': executeMobileIdleCapScenario,
    'MOB-SESSION-LIST-PAGING-01': executeMobileSessionPagingScenario,
    'MOB-SESSION-LIST-CHIPS-01': executeMobileProjectChipsScenario,
    'MOB-SESSION-LIST-MOTION-01': executeMobileSessionListMotionScenario,
    'MOB-SESSION-LIST-PROJECT-SWITCH-01': executeMobileProjectSwitchMotionScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
