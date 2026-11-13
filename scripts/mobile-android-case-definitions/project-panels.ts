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
        media: ['screenshot', 'video'],
        recordingOwner: 'scenario',
        scenario: 'reorder-project-filters',
    },
    'MOB-PROJECT-CHIP-HOLD-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'hold-project-chip-at-strip-edge',
    },
    'MOB-PANELS-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'browse-panels',
    },
    'MOB-PANELS-TABS-SAVED-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'open-session-with-saved-view-tabs',
    },
    'MOB-FILES-PREVIEW-DENSE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'preview-deep-dense-file',
    },
    'MOB-FILES-WORKTREE-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'switch-files-worktree',
    },
    'MOB-PANELS-TREE-REFRESH-01': {
        desktopProfile: 'managed-by-isolated-e2e',
        media: ['screenshot'],
        recordingOwner: 'scenario',
        scenario: 'refresh-expanded-tree',
    },
} as const satisfies Record<string, MobileAndroidCaseDefinition>;
