import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileFilesPreviewScenario } from '../mobile-files-preview-scenario';
import { executeMobileFilesWorktreeScenario } from '../mobile-files-worktree-scenario';
import { executeMobileProjectPanelsScenario } from '../mobile-project-panels-scenarios';
import { executeMobileProjectReorderScenario } from '../mobile-project-reorder-scenario';

export const handlers = {
    'MOB-FILES-PREVIEW-DENSE-01': executeMobileFilesPreviewScenario,
    'MOB-FILES-WORKTREE-01': executeMobileFilesWorktreeScenario,
    'MOB-PANELS-01': executeMobileProjectPanelsScenario,
    'MOB-PANELS-TABS-SAVED-01': executeMobileProjectPanelsScenario,
    'MOB-PANELS-TREE-REFRESH-01': executeMobileProjectPanelsScenario,
    'MOB-PROJECT-01': executeMobileProjectPanelsScenario,
    'MOB-PROJECT-CHIP-HOLD-01': executeMobileProjectPanelsScenario,
    'MOB-PROJECT-REORDER-01': executeMobileProjectReorderScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
