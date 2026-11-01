import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Motion recordings of navigation transitions. Handlers live in `e2e/support/mobile-android-case-handlers/motion.ts`.
 */
export const cases = {
    'MOB-MOTION-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'motion-tab-switch',
    },
    'MOB-MOTION-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'motion-tool-detail-sheet',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
