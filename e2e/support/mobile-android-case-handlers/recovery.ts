import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileRecoveryScenario } from '../mobile-recovery-scenarios';

export const handlers = {
    'MOB-EXIT-REASON-01': executeMobileRecoveryScenario,
    'MOB-PAIR-CANCEL-01': executeMobileRecoveryScenario,
    'MOB-RENDER-01': executeMobileRecoveryScenario,
    'MOB-STORAGE-01': executeMobileRecoveryScenario,
    'MOB-STORAGE-02': executeMobileRecoveryScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
