import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Agent Chat dock cases: the rows above the composer. Handlers live in `e2e/support/mobile-chat-cases/dock.ts`.
 */
export const cases = {
    'MOB-CHAT-DOCK-FOLD-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-dock-fold',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
