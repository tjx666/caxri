import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * `caxri device` actions pushed to the paired phone. Handlers live in
 * `e2e/support/mobile-chat-cases/device-actions.ts`.
 */
export const cases = {
    'MOB-DEVICE-ACTIONS-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'device-actions',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
