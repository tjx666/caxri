import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * A redirect of a running delegated task in the child's Chat (`MOB-DELEGATION-REDIRECT-*`). Handlers live in
 * `e2e/support/mobile-android-case-handlers/delegation-redirect.ts`.
 */
export const cases = {
    'MOB-DELEGATION-REDIRECT-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'agent-chat-delegated-redirect',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
