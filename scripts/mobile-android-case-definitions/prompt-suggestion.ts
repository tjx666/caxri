import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Prompt suggestion cases (#3827). Handlers live in `e2e/support/mobile-android-case-handlers/prompt-suggestion.ts`.
 */
export const cases = {
    'MOB-CHAT-PROMPT-SUGGESTION-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-prompt-suggestion',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
