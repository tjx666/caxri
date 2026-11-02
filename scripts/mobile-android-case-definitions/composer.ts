import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Terminal Session composer delivery: multiline input, stop, and an unknown delivery result. Handlers live in
 * `e2e/support/mobile-android-case-handlers/composer.ts`.
 */
export const cases = {
    'MOB-COMPOSER-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'composer-unicode-submit',
    },
    'MOB-COMPOSER-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'composer-stop',
    },
    'MOB-COMPOSER-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'composer-unknown',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
