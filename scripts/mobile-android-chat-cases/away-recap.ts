import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Away recap cases (#3347). Handlers live in `e2e/support/mobile-chat-cases/away-recap.ts`.
 */
export const cases = {
    'MOB-CHAT-AWAY-RECAP-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-away-recap',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
