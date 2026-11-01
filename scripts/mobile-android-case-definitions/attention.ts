import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Permission and question attention cards answered from the phone. Handlers live in
 * `e2e/support/mobile-android-case-handlers/attention.ts`.
 */
export const cases = {
    'MOB-ATTN-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'agent-permission',
    },
    'MOB-ATTN-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'agent-question',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
