import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Tracker and memory cards at the end of a Chat turn. Handlers live in
 * `e2e/support/mobile-android-case-handlers/tracker-card.ts`.
 */
export const cases = {
    'MOB-CHAT-TRACKER-CARD-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-tracker-card-width',
    },
    'MOB-CHAT-MEMORY-CARD-01': {
        appLocale: 'zh-CN',
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-memory-card',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
