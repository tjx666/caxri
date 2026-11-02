import { executeMobileChatBackScenario } from '../mobile-agent-chat-back-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-BACK-01': executeMobileChatBackScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
