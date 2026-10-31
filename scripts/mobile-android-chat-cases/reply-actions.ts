import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Reply action bar cases (#3354). Handlers live in `e2e/support/mobile-chat-cases/reply-actions.ts`.
 */
export const cases = {
    'MOB-CHAT-REPLY-ACTIONS-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-reply-actions',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
