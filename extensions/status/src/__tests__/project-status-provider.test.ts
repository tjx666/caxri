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
        const provider = new ProjectStatusProvider({
            getCurrentContext: () => ({ scopeId: 'session-a:project-1' }),
            getProjectStatus,
        });
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

    it('keeps a forced refresh from suppressing another scope', async () => {
        let scopeId = 'session-a:project-1';
        const summary = Promise.withResolvers<ProjectStatusSummary>();
        const getProjectStatus = vi.fn<
            (options?: ProjectStatusRequestOptions) => Promise<ProjectStatusSummary>
        >(() => summary.promise);
        const provider = new ProjectStatusProvider({
            getCurrentContext: () => ({ scopeId }),
            getProjectStatus,
        });
        const changed = vi.fn();
        const subscription = provider.onDidChangeTreeData(changed);
        const cancellation = new CancellationTokenSource();

        provider.refresh(true);
        const pending = provider.getChildren(undefined, cancellation.token);
        expect(typeof getProjectStatus.mock.calls[0]?.[0]?.refreshToken).toBe('string');

        scopeId = 'session-b:project-1';
        provider.projectStatusChanged();
        expect(changed).toHaveBeenCalledTimes(2);
        void provider.getChildren(undefined, cancellation.token);
        expect(getProjectStatus.mock.calls[1]?.[0]).toBeUndefined();

        summary.resolve(emptySummary);
        await pending;
        subscription.dispose();
        cancellation.dispose();
        provider.dispose();
    });

    it('re-renders when a running check reaches its next elapsed minute', async () => {
        vi.useFakeTimers();
        const startedAt = 1_000_000;
        const summary: ProjectStatusSummary = {
            refreshedAt: 1,
            repositories: [
                {
                    id: 'fixture',
                    kind: 'primary',
                    name: 'project',
                    branch: 'feat/x',
                    acceptances: [],
                    linearIssues: [],
                    errors: [],
                    pullRequest: {
                        number: 7,
                        title: 'Checks',
                        url: 'https://github.com/acme/widget/pull/7',
                        state: 'pending',
                        checks: [{ name: 'Build', state: 'pending', startedAt }],
                        hiddenCheckCount: 0,
                    },
                },
            ],
        };
        const provider = new ProjectStatusProvider(
            {
                getCurrentContext: () => ({ scopeId: 'session-a:project-1' }),
                getProjectStatus: () => Promise.resolve(summary),
            },
            () => startedAt + 20_000,
        );
        const changed = vi.fn();
        const subscription = provider.onDidChangeTreeData(changed);
        const cancellation = new CancellationTokenSource();

        await provider.getChildren(undefined, cancellation.token);
        vi.advanceTimersByTime(39_999);
        expect(changed).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(changed).toHaveBeenCalledTimes(1);

        // Once nothing runs, no further re-render is armed.
        summary.repositories[0].pullRequest!.checks = [{ name: 'Build', state: 'success' }];
        await provider.getChildren(undefined, cancellation.token);
        vi.advanceTimersByTime(120_000);
        expect(changed).toHaveBeenCalledTimes(1);

        subscription.dispose();
        cancellation.dispose();
        provider.dispose();
        vi.useRealTimers();
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
