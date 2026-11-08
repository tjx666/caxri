import { executeMobileChatCodeBlockScenario } from '../mobile-agent-chat-code-block-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-CODE-01': executeMobileChatCodeBlockScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
