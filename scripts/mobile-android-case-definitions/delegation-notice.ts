import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * A delivered settlement notice in the parent's Chat (`MOB-DELEGATION-NOTICE-*`). Handlers live in
 * `e2e/support/mobile-android-case-handlers/delegation-notice.ts`.
 */
export const cases = {
    'MOB-DELEGATION-NOTICE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-delegation-notice',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
