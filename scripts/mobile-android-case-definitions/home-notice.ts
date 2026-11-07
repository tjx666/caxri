import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * The notice above the Session list (`MOB-SESSION-NOTICE-*`). Handlers live in
 * `e2e/support/mobile-android-case-handlers/home-notice.ts`.
 */
export const cases = {
    'MOB-SESSION-NOTICE-SETTLE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'session-home-notice-settle',
    },
    'MOB-SESSION-NOTICE-RECONNECT-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'session-home-reconnect-notice',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
