import { executeMobileChatContextCompactScenario } from '../mobile-agent-chat-context-compact-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-CONTEXT-COMPACT-01': executeMobileChatContextCompactScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
