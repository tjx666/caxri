import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileComputerRenameScenario } from '../mobile-computer-rename-scenario';

export const handlers = {
    'MOB-COMPUTER-RENAME-01': executeMobileComputerRenameScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
