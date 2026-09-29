import { describe, expect, it } from 'vitest';

import {
    checkedOutReference as repoReference,
    formatRepoCountLabel,
    isNamedAfterBranch,
    repoBranchRow as repoBranchRow,
    syncBadge,
} from '../repo-row-labels';

const zero = { count: 0, uncommittedCount: 0, unpushedCommitCount: 0 };

describe('formatRepoCountLabel', () => {
    it('shows nothing for a clean repository', () => {
        expect(formatRepoCountLabel(zero)).toBe('');
    });

    it('keeps only the nonzero parts', () => {
        expect(formatRepoCountLabel({ ...zero, count: 3 })).toBe(' · 3');
        expect(
            formatRepoCountLabel({ count: 5, uncommittedCount: 1, unpushedCommitCount: 2 }),
        ).toBe(' · 5 · 2 unpushed · 1 uncommitted');
    });
});

describe('syncBadge', () => {
    it('is absent when the branch is level with its upstream', () => {
        expect(syncBadge(0, 0)).toBeUndefined();
    });

    it('keeps only the nonzero directions', () => {
        expect(syncBadge(2, 0)).toBe('↑2');
        expect(syncBadge(0, 1)).toBe('↓1');
        expect(syncBadge(1, 4)).toBe('↑1 ↓4');
    });
});

describe('isNamedAfterBranch', () => {
    it('matches a folder named after its branch with separators flattened', () => {
        expect(
            isNamedAfterBranch('fix-client-ip-cloudflare-edge', 'fix/client-ip-cloudflare-edge'),
        ).toBe(true);
        expect(isNamedAfterBranch('Feature_Login', 'feature/login')).toBe(true);
    });

    it('tolerates a trailing hex disambiguator', () => {
        expect(isNamedAfterBranch('feat-branch-row-6a2ba1f9', 'feat/branch-row')).toBe(true);
    });

    it('rejects a different branch', () => {
        expect(isNamedAfterBranch('caxri', 'main')).toBe(false);
        expect(isNamedAfterBranch('feat-branch-row-extra', 'feat/branch-row')).toBe(false);
    });
});

describe('checkedOutReference', () => {
    it('names a branch by itself', () => {
        expect(repoReference({ branch: 'main' })).toEqual({
            label: 'main',
            summary: 'main',
            detached: false,
        });
    });

    it('names a detached HEAD by the reference at that commit, else its subject', () => {
        expect(
            repoReference({
                branch: '(detached)',
                detachedHead: { subject: 'chore: release', reference: 'v1.2.0' },
            }),
        ).toEqual({
            label: 'v1.2.0',
            summary: 'Detached HEAD at v1.2.0 · chore: release',
            detached: true,
        });
        expect(
            repoReference({
                branch: '(detached)',
                detachedHead: { subject: 'fix: sidebar' },
            }),
        ).toEqual({
            label: 'fix: sidebar',
            summary: 'Detached HEAD · fix: sidebar',
            detached: true,
        });
    });
});

describe('repoBranchRow', () => {
    const worktree = {
        name: 'fix-client-ip-cloudflare-edge',
        branch: 'fix/client-ip-cloudflare-edge',
        ahead: 0,
        behind: 0,
    };

    it('hides the row when it would only repeat the folder name', () => {
        expect(repoBranchRow(worktree)).toMatchObject({ description: '', kind: 'branch' });
    });

    it('keeps a repeated branch that carries unsynced commits', () => {
        expect(repoBranchRow({ ...worktree, ahead: 2 })).toMatchObject({
            description: 'fix/client-ip-cloudflare-edge',
            badge: '↑2',
        });
    });

    it('marks a detached HEAD as a commit', () => {
        expect(
            repoBranchRow({
                name: 'lobehub',
                branch: '(detached)',
                detachedHead: { subject: 'chore: release', reference: 'origin/main' },
                ahead: 0,
                behind: 0,
            }),
        ).toEqual({
            description: 'origin/main',
            kind: 'commit',
            badge: 'detached',
            summary: 'Detached HEAD at origin/main · chore: release',
        });
    });
});
