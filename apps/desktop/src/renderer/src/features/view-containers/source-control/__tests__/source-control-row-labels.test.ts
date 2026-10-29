import type { SourceControlAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    branchRowInteraction,
    branchRowTooltipDetails,
    branchSyncConfirmRequest,
    changedFileCountLabel,
    changedFileCountText,
    trackedRemoteBranch,
} from '../source-control-row-labels';

const sync: SourceControlAction = {
    id: 'action-sync',
    label: 'Sync Changes in project',
    icon: { kind: 'theme', id: 'sync' },
    command: { id: 'publisher.scm.sync', arguments: ['repo-1', 1, 0] },
};

describe('Source Control row labels', () => {
    it('names the group caption count', () => {
        expect(changedFileCountLabel(1, translate)).toBe('1 changed file');
        expect(changedFileCountLabel(2, translate)).toBe('2 changed files');
        expect(changedFileCountText(1, translate)).toBe('1 file');
        expect(changedFileCountText(2, translate)).toBe('2 files');
    });

    it('does not repeat the branch title in the branch tooltip details', () => {
        expect(branchRowTooltipDetails('main', 'main')).toEqual([]);
        expect(branchRowTooltipDetails('main', 'main · tracking origin/main')).toEqual([
            'tracking origin/main',
        ]);
        expect(branchRowTooltipDetails('main', 'Detached HEAD · Fix')).toEqual([
            'Detached HEAD · Fix',
        ]);
    });

    it('opens the branch picker only from the primary repository and syncs from the badge', () => {
        expect(
            branchRowInteraction(
                {
                    actions: [sync],
                    descriptionBadge: '↑1',
                    descriptionBadgeActionId: sync.id,
                    descriptionKind: 'branch',
                },
                translate,
            ),
        ).toEqual({
            canSwitchBranch: true,
            syncAction: sync,
            hints: ['Click or press Enter to switch branches', 'Click ↑1 to sync changes'],
        });
        expect(
            branchRowInteraction(
                {
                    actions: [sync],
                    descriptionKind: 'branch',
                    kindLabel: 'worktree',
                },
                translate,
            ),
        ).toEqual({ canSwitchBranch: false, syncAction: undefined, hints: [] });
        expect(
            branchRowInteraction(
                {
                    actions: [sync],
                    descriptionBadge: 'detached',
                    descriptionKind: 'commit',
                },
                translate,
            ).hints,
        ).toEqual(['Click or press Enter to switch to a branch']);
        expect(
            branchRowInteraction(
                {
                    actions: [{ ...sync, disabled: true }],
                    descriptionBadge: '↓2',
                    descriptionBadgeActionId: sync.id,
                    descriptionKind: 'branch',
                },
                translate,
            ).syncAction,
        ).toBeUndefined();
    });

    it('runs only the action the provider names for its badge, whatever its command id', () => {
        const other: SourceControlAction = {
            ...sync,
            id: 'action-other',
            command: { id: 'publisher.scm.other' },
        };
        // A badge without a named action is status only, even when a sync-looking action exists.
        expect(
            branchRowInteraction(
                {
                    actions: [sync],
                    descriptionBadge: '↑1',
                    descriptionKind: 'branch',
                },
                translate,
            ).syncAction,
        ).toBeUndefined();
        expect(
            branchRowInteraction(
                {
                    actions: [sync, other],
                    descriptionBadge: '↑1 ↓1',
                    descriptionBadgeActionId: other.id,
                    descriptionKind: 'branch',
                },
                translate,
            ).syncAction,
        ).toBe(other);
        // A stale id that names no current action leaves the badge inert instead of guessing.
        expect(
            branchRowInteraction(
                {
                    actions: [sync],
                    descriptionBadge: '↑1',
                    descriptionBadgeActionId: 'action-missing',
                    descriptionKind: 'branch',
                },
                translate,
            ).syncAction,
        ).toBeUndefined();
    });
});

describe('branch sync confirmation', () => {
    it('names the remote branch and both counts, in the order sync runs them', () => {
        expect(
            branchSyncConfirmRequest(
                { descriptionTooltip: 'main · tracking origin/main · 2 ahead, 1 behind' },
                { command: { id: 'publisher.scm.sync', arguments: ['repo-1', 2, 1] } },
                translate,
            ),
        ).toEqual({
            title: 'Sync with origin/main?',
            message:
                'This will pull 1 commit from origin/main, then push 2 commits to origin/main.',
            confirmLabel: 'Sync',
        });
    });

    it('leaves out a zero count and still asks without a known remote', () => {
        expect(
            branchSyncConfirmRequest(
                { descriptionTooltip: 'feature' },
                { command: { id: 'publisher.scm.sync', arguments: ['repo-1', 3, 0] } },
                translate,
            ),
        ).toEqual({
            title: 'Sync this branch?',
            message: 'This will push 3 commits to its remote branch.',
            confirmLabel: 'Sync',
        });
    });

    it('reads the tracked branch from the hover text', () => {
        expect(trackedRemoteBranch('tracking upstream/dev')).toBe('upstream/dev');
        expect(trackedRemoteBranch('main · 1 ahead, 0 behind')).toBeUndefined();
    });
});
