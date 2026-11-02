import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * The Changes view of a Session. Handlers live in `e2e/support/mobile-android-case-handlers/changes.ts`.
 */
export const cases = {
    'MOB-CHANGES-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'changes-list-and-diff',
    },
    'MOB-CHANGES-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'changes-unreviewable-placeholder',
    },
    'MOB-CHANGES-03': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'changes-wide-tablet-pane',
    },
    'MOB-CHANGES-04': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'changes-ask-agent-draft-send',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
