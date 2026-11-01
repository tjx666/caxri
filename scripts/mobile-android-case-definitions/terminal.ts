import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Terminal observation, control, scroll feel, and scrollback. Handlers live in
 * `e2e/support/mobile-android-case-handlers/terminal.ts`.
 */
export const cases = {
    'MOB-TERM-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'terminal-observe-control',
    },
    'MOB-TERM-SCROLL-FEEL-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'terminal-scroll-feel',
    },
    'MOB-TERM-SCROLLBACK-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'terminal-scrollback',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
