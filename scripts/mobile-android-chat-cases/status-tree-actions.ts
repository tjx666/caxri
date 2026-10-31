import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Status panel inline action cases. Handlers live in `e2e/support/mobile-chat-cases/status-tree-actions.ts`.
 */
export const cases = {
    'MOB-CHAT-STATUS-TREE-MERGE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'status-tree-merge',
    },
    'MOB-CHAT-STATUS-TREE-RESOLVE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'status-tree-resolve',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
