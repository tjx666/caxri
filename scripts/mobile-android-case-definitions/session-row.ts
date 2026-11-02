import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Session list row metadata cases. Handlers live in `e2e/support/mobile-android-case-handlers/session-row.ts`.
 */
export const cases = {
    'MOB-SESSION-ROW-META-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'session-row-worktree-and-pull-request',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
