import type { MobileAndroidCaseDefinition } from '../mobile-android-cases';

/**
 * Projects and the Session panels. Handlers live in `e2e/support/mobile-android-case-handlers/project-panels.ts`.
 */
export const cases = {
    'MOB-PROJECT-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'add-nested-project',
    },
    'MOB-PROJECT-REORDER-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'reorder-project-filters',
    },
    'MOB-PANELS-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'browse-panels',
    },
    'MOB-PANELS-TREE-REFRESH-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'refresh-expanded-tree',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
