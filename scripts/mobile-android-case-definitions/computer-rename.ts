import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Renaming the paired computer from the phone. Handlers live in
 * `e2e/support/mobile-android-case-handlers/computer-rename.ts`.
 */
export const cases = {
    'MOB-COMPUTER-RENAME-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'computer-rename',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
