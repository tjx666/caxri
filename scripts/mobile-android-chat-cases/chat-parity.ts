import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Chat parity with Desktop: opening cited files, linking bare URLs, the `/` menu, and the `@` menu. Handlers live in
 * `e2e/support/mobile-chat-cases/chat-parity.ts`.
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
