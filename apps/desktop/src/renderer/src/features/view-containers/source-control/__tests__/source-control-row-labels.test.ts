import type { SourceControlAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

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
    command: { id: 'caxri.git.sync', arguments: ['repo-1', 1, 0] },
};

describe('Source Control row labels', () => {
    it('names the group caption count', () => {
        expect(changedFileCountLabel(1)).toBe('1 changed file');
        expect(changedFileCountLabel(2)).toBe('2 changed files');
        expect(changedFileCountText(1)).toBe('1 file');
        expect(changedFileCountText(2)).toBe('2 files');
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
            branchRowInteraction({
                actions: [sync],
                descriptionBadge: '↑1',
                descriptionKind: 'branch',
            }),
        ).toEqual({
            canSwitchBranch: true,
            syncAction: sync,
            hints: ['Click or press Enter to switch branches', 'Click ↑1 to sync changes'],
        });
        expect(
            branchRowInteraction({
                actions: [sync],
                descriptionKind: 'branch',
                kindLabel: 'worktree',
            }),
        ).toEqual({ canSwitchBranch: false, syncAction: undefined, hints: [] });
        expect(
            branchRowInteraction({
                actions: [sync],
                descriptionBadge: 'detached',
                descriptionKind: 'commit',
            }).hints,
        ).toEqual(['Click or press Enter to switch to a branch']);
        expect(
            branchRowInteraction({
                actions: [{ ...sync, disabled: true }],
                descriptionBadge: '↓2',
                descriptionKind: 'branch',
            }).syncAction,
        ).toBeUndefined();
    });
});

describe('branch sync confirmation', () => {
    it('names the remote branch and both counts, in the order sync runs them', () => {
        expect(
            branchSyncConfirmRequest(
                { descriptionTooltip: 'main · tracking origin/main · 2 ahead, 1 behind' },
                { command: { id: 'caxri.git.sync', arguments: ['repo-1', 2, 1] } },
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
                { command: { id: 'caxri.git.sync', arguments: ['repo-1', 3, 0] } },
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
