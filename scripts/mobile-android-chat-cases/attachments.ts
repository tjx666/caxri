import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Agent Chat attachment cases beyond images. Handlers live in `e2e/support/mobile-chat-cases/attachments.ts`.
 */
export const cases = {
    'MOB-CHAT-FILE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-file',
    },
    'MOB-CHAT-VIDEO-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        motion: 'live',
        recordingOwner: 'scenario',
        scenario: 'agent-chat-video',
    },
    'MOB-CHAT-VIDEO-02': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-video-unavailable',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
