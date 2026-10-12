import { CancellationTokenSource, GitPullRequestErrorMessage } from 'caxri';
import { describe, expect, it, vi } from 'vitest';

import { createHarness, repo, scopeId } from './git-provider.fixture';

describe('pull request error presentation', () => {
    it.each([
        [GitPullRequestErrorMessage.missingCommits, GitPullRequestErrorMessage.missingCommits],
        ['untrusted remote stderr', 'Unable to load pull request changes. Refresh to retry.'],
    ])(
        'only exposes safe messages and clears the error after refresh: %s',
        async (message, expected) => {
            const { git, provider } = createHarness();
            const cancellation = new CancellationTokenSource();
            const request = { scopeId, preferredModeId: 'pull-request', refresh: 0 };
            try {
                vi.mocked(git.pullRequestChanges).mockRejectedValueOnce(new Error(message));
                await provider.provideView(request, cancellation.token);
                await vi.waitFor(async () => {
                    const view = await provider.provideView(request, cancellation.token);
                    expect(view.providers[0].groups[0].emptyMessage).toBe(expected);
                    expect(view.providers[0].countLabel).toBe(' · Unavailable');
                });
                request.refresh = 1;
                await provider.provideView(request, cancellation.token);
                await vi.waitFor(async () => {
                    const view = await provider.provideView(request, cancellation.token);
                    expect(view.providers[0].groups[0].emptyMessage).toBe(
                        'No pull request for this branch.',
                    );
                    expect(view.providers[0].countLabel).not.toContain('Unavailable');
                });
            } finally {
                cancellation.dispose();
                provider.dispose();
            }
        },
    );

    it('explains detached HEAD in Pull Request mode without looking up a pull request', async () => {
        const { git, provider } = createHarness();
        const cancellation = new CancellationTokenSource();
        try {
            vi.mocked(git.summary).mockResolvedValue({
                isRepository: true,
                repositories: [{ ...repo, branch: '(detached)' }],
            });
            const view = await provider.provideView(
                { scopeId, preferredModeId: 'pull-request', refresh: 0 },
                cancellation.token,
            );
            expect(view.providers[0].groups[0].emptyMessage).toBe(
                'Detached HEAD has no pull request. Switch to a branch to see one.',
            );
            expect(git.pullRequestChanges).not.toHaveBeenCalled();
        } finally {
            cancellation.dispose();
            provider.dispose();
        }
    });
});
