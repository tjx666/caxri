import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileSessionAttentionScenario } from '../mobile-session-attention-scenario';

export const handlers = {
    'MOB-SESSION-ATTENTION-DONE-01': executeMobileSessionAttentionScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
