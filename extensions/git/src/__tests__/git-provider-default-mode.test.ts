import './host-api.fixture';

import type { GitPullRequestChanges } from 'caxri';
import { CancellationTokenSource } from 'caxri';
import { describe, expect, it, vi } from 'vitest';

import { hasDetectedPullRequest } from '../pull-request-detection';
import { createHarness, repo, scopeId, summary } from './git-provider.fixture';

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

    it('opens in Pull Request mode once the branch has a pull request, until the user picks a mode', async () => {
        const { git, provider } = createHarness();
        vi.mocked(git.pullRequestChanges).mockResolvedValue(pullRequest);
        const cancellation = new CancellationTokenSource();
        try {
            // The first request only restores the persisted mode, which is not a user choice.
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

    it('stays in Working Tree mode when the branch has no pull request', async () => {
        const { git, provider } = createHarness();
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
