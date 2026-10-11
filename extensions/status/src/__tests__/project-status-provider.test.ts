import type { ProjectStatusRequestOptions, ProjectStatusSummary } from 'caxri';
import { CancellationTokenSource } from 'caxri';
import { describe, expect, it, vi } from 'vitest';

import { mergePullRequest, ProjectStatusProvider } from '../extension';

const emptySummary: ProjectStatusSummary = {
    refreshedAt: 1,
    repositories: [],
};

describe('ProjectStatusProvider', () => {
    it('suppresses the Runtime echo while a forced refresh is pending', async () => {
        const summary = Promise.withResolvers<ProjectStatusSummary>();
        const getProjectStatus = vi.fn<
            (options?: ProjectStatusRequestOptions) => Promise<ProjectStatusSummary>
        >(() => summary.promise);
        const provider = new ProjectStatusProvider({ getProjectStatus });
        const changed = vi.fn();
        const subscription = provider.onDidChangeTreeData(changed);
        const cancellation = new CancellationTokenSource();

        provider.refresh(true);
        expect(changed).toHaveBeenCalledTimes(1);
        const pending = provider.getChildren(undefined, cancellation.token);
        expect(getProjectStatus).toHaveBeenCalledTimes(1);
        expect(typeof getProjectStatus.mock.calls[0]?.[0]?.refreshToken).toBe('string');

        provider.projectStatusChanged();
        expect(changed).toHaveBeenCalledTimes(1);

        summary.resolve(emptySummary);
        const nodes = await pending;
        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.item.id).toBe('status:empty');

        provider.projectStatusChanged();
        expect(changed).toHaveBeenCalledTimes(2);

        subscription.dispose();
        cancellation.dispose();
        provider.dispose();
    });
});

describe('mergePullRequest', () => {
    const target = { repositoryId: 'repo-1', number: 123, headSha: 'a'.repeat(40) };

    it.each([
        ['squash', 'Squash-merged #123'],
        ['merge', 'Merged #123'],
        ['rebase', 'Rebase-merged #123'],
    ] as const)('names the %s method in its result and refreshes', async (method, message) => {
        const refresh = vi.fn();
        const git = {
            mergePullRequest: vi.fn(() =>
                Promise.resolve({ method, url: 'https://github.com/example/repo/pull/123' }),
            ),
        };
        await expect(mergePullRequest({ refresh }, target, git)).resolves.toEqual({ message });
        expect(git.mergePullRequest).toHaveBeenCalledWith('repo-1', {
            number: 123,
            headSha: target.headSha,
        });
        expect(refresh).toHaveBeenCalledWith(true);
    });

    it('refreshes and rethrows when the merge fails', async () => {
        const refresh = vi.fn();
        const git = { mergePullRequest: vi.fn(() => Promise.reject(new Error('not mergeable'))) };
        await expect(mergePullRequest({ refresh }, target, git)).rejects.toThrow('not mergeable');
        expect(refresh).toHaveBeenCalledWith(true);
    });
});
