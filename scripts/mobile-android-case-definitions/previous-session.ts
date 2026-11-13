import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Returning to the previously opened Session. Handlers live in
 * `e2e/support/mobile-android-case-handlers/previous-session.ts`.
 */
export const cases = {
    'MOB-SESSION-PREVIOUS-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-previous',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
