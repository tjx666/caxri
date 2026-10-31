import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Work summary cases. Handlers live in `e2e/support/mobile-chat-cases/work-summary.ts`.
 */
export const cases = {
    'MOB-CHAT-SINGLE-WORK-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-single-work-summary',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
