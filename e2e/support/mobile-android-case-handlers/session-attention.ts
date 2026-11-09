import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import {
    executeMobileSessionAttentionScenario,
    executeMobileSessionRowMarkDoneScenario,
    executeMobileSessionRowSwipeHiddenScenario,
} from '../mobile-session-attention-scenario';

export const handlers = {
    'MOB-SESSION-ATTENTION-DONE-01': executeMobileSessionAttentionScenario,
    'MOB-SESSION-ROW-MARK-DONE-01': executeMobileSessionRowMarkDoneScenario,
    'MOB-SESSION-ROW-SWIPE-HIDDEN-01': executeMobileSessionRowSwipeHiddenScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
