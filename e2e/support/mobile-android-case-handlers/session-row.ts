import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileSessionRowMetaScenario } from '../mobile-session-row-meta-scenario';

export const handlers = {
    'MOB-SESSION-ROW-META-01': executeMobileSessionRowMetaScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
