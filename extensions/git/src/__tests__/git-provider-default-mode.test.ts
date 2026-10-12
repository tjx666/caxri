import './host-api.fixture';

import type { GitPullRequestChanges } from 'caxri';
import { CancellationTokenSource } from 'caxri';
import { describe, expect, it, vi } from 'vitest';

import {
    canAutoSelectPullRequestMode,
    hasDetectedPullRequest,
    shouldAutoSelectPullRequestMode,
} from '../pull-request-detection';
import { createHarness, repo, scopeId, summary } from './git-provider.fixture';

/**
 * Auto-selection never trades uncommitted changes for a pull request diff, so these cases start from a clean tree.
 */
const cleanSummary = {
    ...summary,
    repositories: [{ ...repo, changedFileCount: 0, additions: 0, deletions: 0, files: [] }],
};

const pullRequest: GitPullRequestChanges = {
    repositoryId: repo.id,
    number: 7,
    title: 'Open by default',
    url: 'https://github.com/example/caxri/pull/7',
    baseRefName: 'main',
    headRefName: 'feature/default-mode',
    baseOid: 'a'.repeat(40),
    headOid: 'b'.repeat(40),
    unpushedCommitCount: 0,
    additions: 1,
    deletions: 0,
    files: [],
};

describe('Source Control default mode', () => {
    it('counts only a settled pull request', () => {
        const repositories = [{ id: 'one' }, { id: 'two' }];
        expect(hasDetectedPullRequest(repositories, new Map())).toBe(false);
        expect(hasDetectedPullRequest(repositories, new Map([['one', { value: null }]]))).toBe(
            false,
        );
        expect(
            hasDetectedPullRequest(repositories, new Map([['two', { value: pullRequest }]])),
        ).toBe(true);
        expect(
            hasDetectedPullRequest([{ id: 'one' }], new Map([['two', { value: pullRequest }]])),
        ).toBe(false);
    });

    it('auto-selects only while no repository has uncommitted changes', () => {
        expect(canAutoSelectPullRequestMode([{ changedFileCount: 0 }])).toBe(true);
        expect(
            canAutoSelectPullRequestMode([{ changedFileCount: 0 }, { changedFileCount: 2 }]),
        ).toBe(false);
    });

    it('starts no lookup once the mode is settled or the tree is dirty', () => {
        const load = vi.fn();
        const clean = [{ id: 'one', branch: 'main', changedFileCount: 0 }];
        const found = new Map([['one', { value: pullRequest }]]);
        const open = { isModeChosen: false, mode: 'working', pullRequests: found };
        expect(shouldAutoSelectPullRequestMode(open, clean, load)).toBe(true);
        expect(load).toHaveBeenCalledTimes(1);
        load.mockClear();
        expect(shouldAutoSelectPullRequestMode({ ...open, isModeChosen: true }, clean, load)).toBe(
            false,
        );
        const dirty = [{ ...clean[0], changedFileCount: 1 }];
        expect(shouldAutoSelectPullRequestMode(open, dirty, load)).toBe(false);
        expect(load).not.toHaveBeenCalled();
    });

    it('opens in Pull Request mode once the branch has a pull request, until the user picks a mode', async () => {
        const { git, provider } = createHarness();
        vi.mocked(git.summary).mockResolvedValue(cleanSummary);
        vi.mocked(git.pullRequestChanges).mockResolvedValue(pullRequest);
        const cancellation = new CancellationTokenSource();
        try {
            // The first request only restores the persisted mode, which is not a user choice: the Renderer persists
            // whatever mode the provider reported, including the default Working Tree mode.
            await provider.provideView(
                { scopeId, preferredModeId: 'working', refresh: 0 },
                cancellation.token,
            );
            await vi.waitFor(async () => {
                const view = await provider.provideView(
                    { scopeId, preferredModeId: 'working', refresh: 0 },
                    cancellation.token,
                );
                expect(view.selectedModeId).toBe('pull-request');
            });

            provider.setMode('working', scopeId);
            await vi.waitFor(async () => {
                const view = await provider.provideView(
                    { scopeId, preferredModeId: 'working', refresh: 0 },
                    cancellation.token,
                );
                expect(view.selectedModeId).toBe('working');
            });
            const kept = await provider.provideView(
                { scopeId, preferredModeId: 'working', refresh: 1 },
                cancellation.token,
            );
            expect(kept.selectedModeId).toBe('working');
        } finally {
            cancellation.dispose();
            provider.dispose();
        }
    });

    it('never leaves Working Tree mode on its own while the tree has uncommitted changes', async () => {
        const { git, provider } = createHarness();
        vi.mocked(git.pullRequestChanges).mockResolvedValue(pullRequest);
        const cancellation = new CancellationTokenSource();
        try {
            await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
            await new Promise((resolve) => setTimeout(resolve, 50));
            const view = await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
            expect(view.selectedModeId).toBe('working');
        } finally {
            cancellation.dispose();
            provider.dispose();
        }
    });

    it('stays in Working Tree mode when the branch has no pull request', async () => {
        const { git, provider } = createHarness();
        vi.mocked(git.summary).mockResolvedValue(cleanSummary);
        const cancellation = new CancellationTokenSource();
        try {
            await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
            await vi.waitFor(() => expect(git.pullRequestChanges).toHaveBeenCalled());
            const view = await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
            expect(view.selectedModeId).toBe('working');
        } finally {
            cancellation.dispose();
            provider.dispose();
        }
    });

    it('never looks up a pull request for a detached HEAD', async () => {
        const { git, provider } = createHarness();
        vi.mocked(git.summary).mockResolvedValue({
            ...summary,
            repositories: [{ ...repo, branch: '(detached)' }],
        });
        const cancellation = new CancellationTokenSource();
        try {
            const view = await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(git.pullRequestChanges).not.toHaveBeenCalled();
            expect(view.selectedModeId).toBe('working');
        } finally {
            cancellation.dispose();
            provider.dispose();
        }
    });

    it('treats a Renderer request that changes the returned mode as a choice', async () => {
        const { git, provider } = createHarness();
        const cancellation = new CancellationTokenSource();
        try {
            await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
            await provider.provideView(
                { scopeId, preferredModeId: 'commit', refresh: 0 },
                cancellation.token,
            );
            vi.mocked(git.pullRequestChanges).mockResolvedValue(pullRequest);
            await provider.provideView(
                { scopeId, preferredModeId: 'working', refresh: 1 },
                cancellation.token,
            );
            await new Promise((resolve) => setTimeout(resolve, 100));
            const view = await provider.provideView(
                { scopeId, preferredModeId: 'working', refresh: 1 },
                cancellation.token,
            );
            expect(view.selectedModeId).toBe('working');
        } finally {
            cancellation.dispose();
            provider.dispose();
        }
    });
});
