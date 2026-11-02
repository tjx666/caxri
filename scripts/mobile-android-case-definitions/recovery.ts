import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Recovery from cancelled pairing, render failure, exit reasons, and storage faults. Handlers live in
 * `e2e/support/mobile-android-case-handlers/recovery.ts`.
 */
export const cases = {
    'MOB-PAIR-CANCEL-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'pairing-cancel',
    },
    'MOB-RENDER-01': {
        desktopProfile: 'not-required',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'render-retry',
    },
    'MOB-EXIT-REASON-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'previous-exit-report',
    },
    'MOB-STORAGE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'credential-storage-retry',
    },
    'MOB-STORAGE-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'composer-draft-restart',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
