import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Composer delivery: the Terminal Session composer's multiline input, stop, and an unknown delivery result, the Chat
 * composer's one-row capsule, and the Chat composer emptying after a send. Handlers live in
 * `e2e/support/mobile-android-case-handlers/composer.ts`.
 */
export const cases = {
    'MOB-COMPOSER-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'composer-unicode-submit',
    },
    'MOB-COMPOSER-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'composer-stop',
    },
    'MOB-COMPOSER-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'composer-unknown',
    },
    'MOB-COMPOSER-CAPSULE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-composer-capsule-layout',
    },
    'MOB-COMPOSER-CAPSULE-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-composer-add-sheet',
    },
    'MOB-COMPOSER-CAPSULE-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-composer-running',
    },
    'MOB-COMPOSER-CAPSULE-04': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-composer-offline',
    },
    'MOB-CHAT-CLEAR-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-clear-after-send',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
