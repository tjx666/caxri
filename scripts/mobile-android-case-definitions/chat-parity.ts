import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Chat parity with Desktop: opening cited files, linking bare URLs in replies and the user's own messages, Markdown in
 * questions, the `/` menu, and the `@` menu. Handlers live in
 * `e2e/support/mobile-android-case-handlers/chat-parity.ts`.
 */
export const cases = {
    'MOB-CHAT-FILE-CHIP-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-file-chip',
    },
    'MOB-CHAT-FILE-LINK-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-file-link',
    },
    'MOB-CHAT-BARE-LINK-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-bare-link',
    },
    'MOB-CHAT-USER-LINK-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-user-link',
    },
    'MOB-CHAT-USER-MARKDOWN-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-user-markdown',
    },
    'MOB-CHAT-QUESTION-MARKDOWN-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-question-markdown',
    },
    'MOB-CHAT-COMPOSER-MARKDOWN-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-composer-markdown',
    },
    'MOB-CHAT-COMPOSER-IMAGES-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        motion: 'live',
        recordingOwner: 'scenario',
        scenario: 'agent-chat-composer-images',
    },
    'MOB-CHAT-SLASH-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-slash-commands',
    },
    'MOB-CHAT-MENTION-FILE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-mention-file',
    },
    'MOB-CHAT-MENTION-SESSION-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-mention-session',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
