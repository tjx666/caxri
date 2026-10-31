import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Compacting a nearly full context from the phone's context notice (#3314). Handler lives in
 * `e2e/support/mobile-chat-cases/context-compact.ts`.
 */
export const cases = {
    'MOB-CHAT-CONTEXT-COMPACT-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-context-compact',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
