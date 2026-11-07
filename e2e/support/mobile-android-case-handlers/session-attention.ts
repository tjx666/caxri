import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import {
    executeMobileSessionAttentionScenario,
    executeMobileSessionRowMarkDoneScenario,
} from '../mobile-session-attention-scenario';

export const handlers = {
    'MOB-SESSION-ATTENTION-DONE-01': executeMobileSessionAttentionScenario,
    'MOB-SESSION-ROW-MARK-DONE-01': executeMobileSessionRowMarkDoneScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
