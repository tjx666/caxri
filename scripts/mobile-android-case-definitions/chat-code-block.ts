import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * A code block wider than the phone in an Agent reply: sideways scroll while the reply streams, and Copy shown on tap.
 * Handlers live in `e2e/support/mobile-android-case-handlers/chat-code-block.ts`.
 */
export const cases = {
    'MOB-CHAT-CODE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-code-block',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
