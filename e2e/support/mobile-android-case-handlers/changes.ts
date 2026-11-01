import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileChangesScenario } from '../mobile-changes-scenarios';

export const handlers = {
    'MOB-CHANGES-01': executeMobileChangesScenario,
    'MOB-CHANGES-02': executeMobileChangesScenario,
    'MOB-CHANGES-03': executeMobileChangesScenario,
    'MOB-CHANGES-04': executeMobileChangesScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
