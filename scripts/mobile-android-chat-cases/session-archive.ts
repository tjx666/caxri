import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Archive with Undo from the Session list (#3414). Handlers live in `e2e/support/mobile-chat-cases/session-archive.ts`.
 */
export const cases = {
    'MOB-SESSION-ARCHIVE-UNDO-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-archive-undo',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
