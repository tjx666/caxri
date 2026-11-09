import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * A Chat's own model choice on the phone: synced from Desktop, kept across a provider restart, and reset to the global
 * default (#3880). Handlers live in `e2e/support/mobile-android-case-handlers/chat-choice.ts`.
 */
export const cases = {
    'MOB-CHAT-CHOICE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-model-choice',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
