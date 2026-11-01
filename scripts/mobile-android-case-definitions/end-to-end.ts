import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Integrated journeys across Desktop and phone. Handlers live in
 * `e2e/support/mobile-android-case-handlers/end-to-end.ts`.
 */
export const cases = {
    'MOB-E2E-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'journey-phone',
    },
    'MOB-E2E-02A': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-background-recovery',
    },
    'MOB-E2E-02B': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-network-recovery',
    },
    'MOB-E2E-02C': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-desktop-revocation',
    },
    'MOB-E2E-02D': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-simultaneous-terminal',
    },
    'MOB-E2E-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'journey-tablet',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
