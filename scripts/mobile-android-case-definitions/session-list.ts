import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Which Sessions the home list gives a row. Handlers live in
 * `e2e/support/mobile-android-case-handlers/session-list.ts`.
 */
export const cases = {
    'MOB-SESSION-LIST-NESTED-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-list-nested-sessions',
    },
    'MOB-SESSION-LIST-IDLE-CAP-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-list-idle-cap',
    },
    'MOB-SESSION-LIST-MOTION-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        motion: 'live',
        recordingOwner: 'scenario',
        scenario: 'session-list-motion',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
