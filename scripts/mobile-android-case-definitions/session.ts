import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Session list and detail layouts, stale connections, and push refresh. Handlers live in
 * `e2e/support/mobile-android-case-handlers/session.ts`.
 */
export const cases = {
    'MOB-SESSION-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'session-states',
    },
    'MOB-SESSION-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'adapter',
        scenario: 'session-reconnect',
    },
    'MOB-SESSION-PUSH-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-detail-push',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
