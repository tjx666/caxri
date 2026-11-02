import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Copy on a quote in an Agent reply (#3512). Handlers live in
 * `e2e/support/mobile-android-case-handlers/chat-quote-copy.ts`.
 */
export const cases = {
    'MOB-CHAT-QUOTE-COPY-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-quote-copy',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
