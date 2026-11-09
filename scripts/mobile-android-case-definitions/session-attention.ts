import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Session list status groups and Mark as Done. Handlers live in
 * `e2e/support/mobile-android-case-handlers/session-attention.ts`.
 */
export const cases = {
    'MOB-SESSION-ATTENTION-DONE-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-attention-mark-done',
    },
    'MOB-SESSION-ROW-MARK-DONE-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-row-mark-done',
    },
    'MOB-SESSION-ROW-SWIPE-HIDDEN-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        motion: 'live',
        recordingOwner: 'scenario',
        scenario: 'session-row-swipe-hidden',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
