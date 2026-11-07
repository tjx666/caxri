import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileNestedSessionsScenario } from '../mobile-nested-sessions-scenario';

export const handlers = {
    'MOB-SESSION-LIST-NESTED-01': executeMobileNestedSessionsScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
