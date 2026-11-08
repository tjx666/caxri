import { executeMobileChatPromptSuggestionScenario } from '../mobile-agent-chat-prompt-suggestion-scenario';
import type { MobileAndroidCaseHandler } from '../mobile-android-case-registry';

export const handlers = {
    'MOB-CHAT-PROMPT-SUGGESTION-01': executeMobileChatPromptSuggestionScenario,
} satisfies Record<string, MobileAndroidCaseHandler>;
