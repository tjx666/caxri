import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Composer suggestions, image attachment, and file edit actions on a Terminal Session. Handlers live in
 * `e2e/support/mobile-android-case-handlers/agent-actions.ts`.
 */
export const cases = {
    'MOB-COMPOSE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'agent-composer-suggestions',
    },
    'MOB-COMPOSE-02': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['video'],
        recordingOwner: 'scenario',
        scenario: 'agent-image-attachment',
    },
    'MOB-EDIT-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'file-edit-conflict',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
