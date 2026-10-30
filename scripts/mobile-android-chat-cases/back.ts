import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Back navigation cases. Handlers live in `e2e/support/mobile-chat-cases/back.ts`.
 */
export const cases = {
    'MOB-CHAT-BACK-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        motion: 'live',
        recordingOwner: 'scenario',
        scenario: 'agent-chat-back',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
