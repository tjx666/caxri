import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Conversation rendering of Terminal Sessions and the timeline. Handlers live in
 * `e2e/support/mobile-android-case-handlers/conversation.ts`.
 */
export const cases = {
    'MOB-CONV-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'conversation-content',
    },
    'MOB-CONV-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'conversation-follow',
    },
    'MOB-CONV-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'conversation-shell-fallback',
    },
    'MOB-CONV-04': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'conversation-tablet-font',
    },
    'MOB-CONV-05': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'conversation-open-return',
    },
    'MOB-TIMELINE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: [],
        recordingOwner: 'adapter',
        scenario: 'timeline-projection',
    },
    'MOB-UI-04': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'adapter',
        scenario: 'conversation-shell-fallback',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
