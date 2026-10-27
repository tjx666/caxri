import type { WorkbenchRootOption } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    conversationWorkbenchRoots,
    conversationWorkbenchRootSuggestion,
    visibleWorkbenchRoots,
    workbenchRootForBranch,
} from '../workbench-root-options';

function option(
    overrides: Partial<WorkbenchRootOption> & Pick<WorkbenchRootOption, 'branch' | 'rootPath'>,
): WorkbenchRootOption {
    return {
        worktreeId: overrides.rootPath,
        authorization: 'authorized',
        title: overrides.rootPath,
        isMain: false,
        owner: false,
        ...overrides,
    };
}

const main = option({ branch: 'main', rootPath: '/repo', isMain: true, projectId: 'repo' });
const alpha = option({ branch: 'feat/alpha', rootPath: '/worktrees/alpha', createdAt: 3 });
const beta = option({ branch: 'feat/beta', rootPath: '/worktrees/beta', createdAt: 2 });
const gamma = option({ branch: 'feat/gamma', rootPath: '/worktrees/gamma', createdAt: 1 });

describe('Workbench Root picker options', () => {
    it('orders the conversation group by rank, not by recency of creation', () => {
        const roots = [
            main,
            { ...alpha, conversationRank: 1 },
            beta,
            { ...gamma, conversationRank: 0 },
        ];
        expect(conversationWorkbenchRoots(roots).map((root) => root.rootPath)).toEqual([
            '/worktrees/gamma',
            '/worktrees/alpha',
        ]);
    });

    it('points the closed trigger at the top-ranked conversation worktree', () => {
        const roots = [main, { ...alpha, conversationRank: 1 }, { ...beta, conversationRank: 0 }];
        expect(conversationWorkbenchRootSuggestion(roots, false)).toBe('feat/beta');
    });

    /**
     * Once the Session moved to a linked worktree, the binding answers "which worktree", so the trigger stops pointing.
     */
    it('suggests nothing from a linked worktree or without a recommendation', () => {
        expect(
            conversationWorkbenchRootSuggestion([main, { ...alpha, conversationRank: 0 }], true),
        ).toBeUndefined();
        expect(conversationWorkbenchRootSuggestion([main, alpha], false)).toBeUndefined();
    });

    it('is empty when the Server sent no recommendation', () => {
        expect(conversationWorkbenchRoots([main, alpha, beta])).toEqual([]);
    });

    it('keeps a recommended worktree out of the ordinary list so it cannot appear twice', () => {
        const roots = [main, alpha, beta, gamma];
        const visible = visibleWorkbenchRoots(roots, 'repo', false, new Set(['/worktrees/alpha']));
        expect(visible.map((root) => root.rootPath)).toEqual([
            '/repo',
            '/worktrees/beta',
            '/worktrees/gamma',
        ]);
    });

    it('lists every worktree when nothing is excluded', () => {
        expect(
            visibleWorkbenchRoots([main, alpha, beta, gamma], 'repo', false).map(
                (root) => root.rootPath,
            ),
        ).toEqual(['/repo', '/worktrees/alpha', '/worktrees/beta', '/worktrees/gamma']);
    });
});

describe('workbenchRootForBranch', () => {
    it('finds the one worktree checked out on the pull request branch', () => {
        expect(workbenchRootForBranch([main, alpha, beta], 'feat/alpha', 'repo')).toBe(alpha);
    });

    it('never offers the current root or a branch no worktree has', () => {
        expect(workbenchRootForBranch([main, alpha], 'main', 'repo')).toBeUndefined();
        expect(workbenchRootForBranch([main, alpha], 'feat/missing', 'repo')).toBeUndefined();
    });

    it('does not guess between two checkouts of the same branch', () => {
        const twin = option({ branch: 'feat/alpha', rootPath: '/worktrees/alpha-2' });
        expect(workbenchRootForBranch([main, alpha, twin], 'feat/alpha', 'repo')).toBeUndefined();
    });
});
