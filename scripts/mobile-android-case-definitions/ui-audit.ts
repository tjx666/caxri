import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * UI audit screens and Session search. Handlers live in `e2e/support/mobile-android-case-handlers/ui-audit.ts`.
 */
export const cases = {
    'MOB-UI-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-project-tab',
    },
    'MOB-UI-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-changes',
    },
    'MOB-UI-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-offline',
    },
    'MOB-UI-05': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-project-icons',
    },
    'MOB-UI-06': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-session-management',
    },
    'MOB-UI-07': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-settings',
    },
    'MOB-UI-DESKTOP-UPDATE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-desktop-update',
    },
    'MOB-UI-08': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-rename-keyboard-avoidance',
    },
    'MOB-UI-09': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-host-status',
    },
    'MOB-UI-10': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-host-status',
    },
    'MOB-SESSION-SEARCH-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-session-search',
    },
    'MOB-SESSION-SEARCH-ZH-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'ui-audit-session-search',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
