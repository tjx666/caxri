import type { SourceControlAction } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    branchRowInteraction,
    branchRowTooltipDetails,
    changedFileCountLabel,
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
