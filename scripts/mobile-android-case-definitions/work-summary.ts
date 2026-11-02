import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Work summary cases. Handlers live in `e2e/support/mobile-android-case-handlers/work-summary.ts`.
 */
export const cases = {
    'MOB-CHAT-SINGLE-WORK-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-single-work-summary',
    },
    'MOB-CHAT-WORK-GROUP-OPEN-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-work-group-stays-open',
    },
    'MOB-CHAT-WORK-GROUP-TITLE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-work-group-one-line-title',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
