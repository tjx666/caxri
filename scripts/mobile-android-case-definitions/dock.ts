import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Agent Chat dock cases: the rows above the composer. Handlers live in
 * `e2e/support/mobile-android-case-handlers/dock.ts`.
 */
export const cases = {
    'MOB-CHAT-DOCK-FOLD-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-dock-fold',
    },
    'MOB-CHAT-DOCK-KEYBOARD-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        // The dock's transition is off under reduced motion, which would hide the motion this case records.
        motion: 'live',
        recordingOwner: 'scenario',
        scenario: 'agent-chat-dock-keyboard',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
