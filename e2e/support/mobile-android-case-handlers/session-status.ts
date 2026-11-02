import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';
import { executeMobileSessionStatusScenario } from '../mobile-session-status-scenario';

export const handlers = {
    'MOB-CHAT-SESSION-STATUS-01': executeMobileSessionStatusScenario,
    'MOB-CHAT-SESSION-STATUS-02': executeMobileSessionStatusScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
