import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * The Connection method setting on the phone. Handlers live in
 * `e2e/support/mobile-android-case-handlers/settings-route.ts`.
 */
export const cases = {
    'MOB-SETTINGS-ROUTE-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'settings-route',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
