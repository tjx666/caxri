import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileProjectPanelsScenario } from '../mobile-project-panels-scenarios';

export const handlers = {
    'MOB-PANELS-01': executeMobileProjectPanelsScenario,
    'MOB-PANELS-TREE-REFRESH-01': executeMobileProjectPanelsScenario,
    'MOB-PROJECT-01': executeMobileProjectPanelsScenario,
    'MOB-PROJECT-REORDER-01': executeMobileProjectPanelsScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
