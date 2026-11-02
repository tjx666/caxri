import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Starting a Session from the phone, including cross-device and partial-failure paths. Handlers live in
 * `e2e/support/mobile-android-case-handlers/new-session.ts`.
 */
export const cases = {
    'MOB-NEW-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'new-session-create',
    },
    'MOB-NEW-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'new-session-launch-failure',
    },
    'MOB-CROSS-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'cross-device-new-session',
    },
    'MOB-NEW-SWITCH-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'new-session-project-switch',
    },
    'MOB-PARTIAL-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'partial-new-session-launch-failure',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
