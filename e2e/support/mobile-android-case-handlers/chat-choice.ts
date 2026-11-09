import { executeMobileChatChoiceScenario } from '../mobile-agent-chat-choice-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-CHOICE-01': executeMobileChatChoiceScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
