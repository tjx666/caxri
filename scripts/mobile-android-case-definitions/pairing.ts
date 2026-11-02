import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * First pairing with a denied camera and credential revocation. Handlers live in
 * `e2e/support/mobile-android-case-handlers/pairing.ts`.
 */
export const cases = {
    'MOB-PAIR-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'pairing-recovery',
    },
    'MOB-PAIR-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'adapter',
        scenario: 'pairing-revocation',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
