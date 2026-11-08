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
    'MOB-CHAT-WORK-GROUP-FOLD-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        motion: 'live',
        recordingOwner: 'scenario',
        scenario: 'agent-chat-work-group-fold-in-place',
    },
    'MOB-CHAT-STEER-REPLY-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-steer-reply-thought',
    },
    'MOB-CHAT-WORK-GROUP-TITLE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-work-group-one-line-title',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
