import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileProjectPanelsScenario } from '../mobile-project-panels-scenarios';
import { executeMobileProjectReorderScenario } from '../mobile-project-reorder-scenario';

export const handlers = {
    'MOB-PANELS-01': executeMobileProjectPanelsScenario,
    'MOB-PANELS-TREE-REFRESH-01': executeMobileProjectPanelsScenario,
    'MOB-PROJECT-01': executeMobileProjectPanelsScenario,
    'MOB-PROJECT-CHIP-HOLD-01': executeMobileProjectPanelsScenario,
    'MOB-PROJECT-REORDER-01': executeMobileProjectReorderScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
