import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Motion recordings of navigation transitions. `MOB-MOTION-01` analyses its panels sliding in, so it records live
 * animation, which the runner otherwise turns off for a whole batch (#3785). `MOB-MOTION-03` asserts only the sheet's
 * layout and scrolling, and its Conversation fixture keeps a Working spinner that would stop every UIAutomator read
 * under live motion, so it stays reduced. Handlers live in `e2e/support/mobile-android-case-handlers/motion.ts`.
 */
export const cases = {
    'MOB-MOTION-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        motion: 'live',
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
