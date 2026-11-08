import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * The Session side panel the header button opens (a drawer on a phone, docked on a wide tablet), and the header menu's
 * switch between a PTY Agent Session's Conversation and Terminal. Handlers live in
 * `e2e/support/mobile-android-case-handlers/side-panel.ts`.
 */
export const cases = {
    'MOB-SIDE-PANEL-PHONE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-side-panel-phone',
    },
    'MOB-SIDE-PANEL-PHONE-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-content-switch-menu',
    },
    'MOB-SIDE-PANEL-PHONE-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        motion: 'live',
        recordingOwner: 'scenario',
        scenario: 'session-side-panel-close',
    },
    'MOB-SIDE-PANEL-TABLET-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-side-panel-tablet',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
