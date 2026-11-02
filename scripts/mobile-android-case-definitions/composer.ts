import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Composer delivery: the Terminal Session composer's multiline input, stop, and an unknown delivery result, and the
 * Chat composer emptying after a send. Handlers live in `e2e/support/mobile-android-case-handlers/composer.ts`.
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
    'MOB-CHAT-CLEAR-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-clear-after-send',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
