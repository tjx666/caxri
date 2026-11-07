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
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
