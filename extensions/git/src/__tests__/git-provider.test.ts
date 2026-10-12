import { AsyncLocalStorage } from 'node:async_hooks';
import { Buffer } from 'node:buffer';

import type { GitCommitDetails, GitPullRequestChanges, GitSummary } from 'caxri';
import { CancellationTokenSource } from 'caxri';
import { describe, expect, it, vi } from 'vitest';

import { commitDetails, createHarness, repo, scopeId, summary } from './git-provider.fixture';

describe('GitProvider', () => {
    it('opens an authorized arbitrary commit in the scoped commit mode and survives a stale preferred mode', async () => {
        const selectedSha = 'abcdef0123456789abcdef0123456789abcdef01';
        const { git, provider } = createHarness();
        vi.mocked(git.commitDetails).mockImplementation(({ sha }) =>
            Promise.resolve({
                ...commitDetails,
                commit: { ...commitDetails.commit, sha, shortSha: sha.slice(0, 7) },
            }),
        );
        const changes: unknown[] = [];
        const subscription = provider.onDidChange((change) => changes.push(change));
        const cancellation = new CancellationTokenSource();
        await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);

        await provider.openCommit(scopeId, repo.id, selectedSha, cancellation.token);
        const loading = await provider.provideView(
            { scopeId, preferredModeId: 'working', refresh: 0 },
            cancellation.token,
        );
        await vi.waitFor(() =>
            expect(git.commitDetails).toHaveBeenCalledWith(
                { repositoryId: repo.id, sha: selectedSha },
                expect.anything(),
            ),
        );
        const ready = await provider.provideView(
            { scopeId, preferredModeId: 'working', refresh: 0 },
            cancellation.token,
        );

        expect(loading.selectedModeId).toBe('commit');
        expect(ready.modes.find(({ id }) => id === 'commit')?.label).toBe(
            'Commit Changes (abcdef0)',
        );
        // The row's description is the branch in every mode; the selected commit reaches the user through the hover.
        expect(ready.providers[0].descriptionTooltip).toContain('abcdef0');
        expect(changes).toContainEqual({ kind: 'selection', selectedModeId: 'commit' });

        provider.setMode('working', scopeId);
        await expect(
            provider.provideView(
                { scopeId, preferredModeId: 'working', refresh: 0 },
                cancellation.token,
            ),
        ).resolves.toMatchObject({ selectedModeId: 'working' });
        await expect(
            provider.openCommit(scopeId, 'missing', selectedSha, cancellation.token),
        ).rejects.toMatchObject({ code: 'PROJECT_SCOPE_DENIED' });

        subscription.dispose();
        cancellation.dispose();
        provider.dispose();
    });

    it('keeps the newest commit selection when an earlier validation finishes last', async () => {
        const firstSha = 'abcdef0123456789abcdef0123456789abcdef01';
        const secondSha = '123456789abcdef0123456789abcdef012345678';
        const firstSummary = Promise.withResolvers<GitSummary>();
        const secondSummary = Promise.withResolvers<GitSummary>();
        const { git, provider } = createHarness();
        const cancellation = new CancellationTokenSource();
        await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        vi.mocked(git.summary)
            .mockImplementationOnce(() => firstSummary.promise)
            .mockImplementationOnce(() => secondSummary.promise);

        const first = provider.openCommit(scopeId, repo.id, firstSha, cancellation.token);
        const second = provider.openCommit(scopeId, repo.id, secondSha, cancellation.token);
        secondSummary.resolve(summary);
        await second;
        firstSummary.resolve(summary);
        await first;
        const view = await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);

        expect(view.modes.find(({ id }) => id === 'commit')?.label).toBe(
            'Commit Changes (1234567)',
        );

        cancellation.dispose();
        provider.dispose();
    });

    it('keeps a failed selected commit visible instead of silently showing HEAD', async () => {
        const selectedSha = 'abcdef0123456789abcdef0123456789abcdef01';
        const { git, provider } = createHarness();
        vi.mocked(git.commitDetails).mockRejectedValueOnce(new Error('commit disappeared'));
        const cancellation = new CancellationTokenSource();
        await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        await provider.openCommit(scopeId, repo.id, selectedSha, cancellation.token);

        await expect
            .poll(async () => {
                const view = await provider.provideView(
                    { scopeId, preferredModeId: 'commit', refresh: 0 },
                    cancellation.token,
                );
                return {
                    emptyMessage: view.providers[0]?.groups[0]?.emptyMessage,
                    label: view.modes.find(({ id }) => id === 'commit')?.label,
                };
            })
            .toEqual({
                emptyMessage: 'Unable to load commit abcdef0.',
                label: 'Commit Changes (abcdef0)',
            });

        cancellation.dispose();
        provider.dispose();
    });

    it('publishes content when Last Commit clears an arbitrary commit selection', async () => {
        const selectedSha = 'abcdef0123456789abcdef0123456789abcdef01';
        const { provider } = createHarness();
        const cancellation = new CancellationTokenSource();
        const changes: string[] = [];
        const subscription = provider.onDidChange((change) => changes.push(change.kind));
        await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        await provider.openCommit(scopeId, repo.id, selectedSha, cancellation.token);
        await provider.provideView(
            { scopeId, preferredModeId: 'commit', refresh: 0 },
            cancellation.token,
        );
        changes.length = 0;

        provider.setMode('commit', scopeId);
        await vi.waitFor(() => expect(changes).toContain('content'));
        const view = await provider.provideView(
            { scopeId, preferredModeId: 'commit', refresh: 0 },
            cancellation.token,
        );

        expect(view.modes.find(({ id }) => id === 'commit')?.label).toBe('Last Commit Changes');

        subscription.dispose();
        cancellation.dispose();
        provider.dispose();
    });

    it('keeps mode and refresh generations isolated and monotonic per Workbench scope', async () => {
        const { git, provider } = createHarness();
        const cancellation = new CancellationTokenSource();

        const sessionA = await provider.provideView(
            {
                scopeId: 'session-a:project-a',
                preferredModeId: 'commit',
                refresh: 3,
            },
            cancellation.token,
        );
        const sessionB = await provider.provideView(
            { scopeId: 'session-b:project-b', refresh: 0 },
            cancellation.token,
        );
        const sessionAAfterRemount = await provider.provideView(
            { scopeId: 'session-a:project-a', refresh: 0 },
            cancellation.token,
        );

        expect(sessionA.selectedModeId).toBe('commit');
        expect(sessionB.selectedModeId).toBe('working');
        expect(sessionAAfterRemount.selectedModeId).toBe('commit');
        // The Renderer's query counter never reaches Host as a forcing nonce; only actions do (see the next test).
        expect(git.summary.mock.calls.map(([refresh]) => refresh)).toEqual([0, 0, 0]);

        cancellation.dispose();
        provider.dispose();
    });

    it('keeps a multi-repository model below the Extension Host payload ceiling', async () => {
        const largeSummary: GitSummary = {
            isRepository: true,
            repositories: Array.from({ length: 5 }, (_unused, repoIndex) => ({
                ...repo,
                id: `repo-${repoIndex}`,
                name: `repository-${repoIndex}`,
                files: Array.from({ length: 1_000 }, (_entry, fileIndex) => ({
                    path: `packages/feature-${repoIndex}/${'nested/'.repeat(18)}file-${fileIndex}.ts`,
                    index: ' ',
                    workingTree: 'M',
                    kind: 'modified' as const,
                })),
                changedFileCount: 1_000,
            })),
        };
        const { git, provider } = createHarness();
        vi.mocked(git.summary).mockResolvedValue(largeSummary);
        const cancellation = new CancellationTokenSource();

        const view = await provider.provideView(
            { scopeId: 'session-a:project-a', refresh: 0 },
            cancellation.token,
        );

        expect(Buffer.byteLength(JSON.stringify(view), 'utf8')).toBeLessThan(4 * 1024 * 1024);
        expect(view.providers).toHaveLength(5);
        expect(
            view.providers.every((providerModel) => providerModel.groups[0]?.resources.length),
        ).toBe(true);
        expect(
            view.providers.some((providerModel) => providerModel.groups[0]?.truncationMessage),
        ).toBe(true);

        cancellation.dispose();
        provider.dispose();
    });

    it('bounds concurrent background detail requests across repositories', async () => {
        const manyRepositories: GitSummary = {
            isRepository: true,
            repositories: Array.from({ length: 6 }, (_unused, index) => ({
                ...repo,
                id: `repo-${index}`,
                name: `repository-${index}`,
                files: [],
                changedFileCount: 0,
            })),
        };
        const requests: Array<ReturnType<typeof Promise.withResolvers<GitCommitDetails>>> = [];
        const { git, provider } = createHarness();
        vi.mocked(git.summary).mockResolvedValue(manyRepositories);
        vi.mocked(git.commitDetails).mockImplementation(() => {
            const request = Promise.withResolvers<GitCommitDetails>();
            requests.push(request);
            return request.promise;
        });
        const cancellation = new CancellationTokenSource();

        await provider.provideView(
            { scopeId, preferredModeId: 'commit', refresh: 0 },
            cancellation.token,
        );

        expect(git.commitDetails).toHaveBeenCalledTimes(4);
        requests[0].resolve(commitDetails);
        await vi.waitFor(() => expect(git.commitDetails).toHaveBeenCalledTimes(5));

        cancellation.dispose();
        provider.dispose();
    });

    it('preserves each Workbench scope while a global detail slot is transferred', async () => {
        const context = new AsyncLocalStorage<string>();
        const manyRepositories: GitSummary = {
            isRepository: true,
            repositories: Array.from({ length: 6 }, (_unused, index) => ({
                ...repo,
                id: `repo-a-${index}`,
                name: `repository-a-${index}`,
                files: [],
                changedFileCount: 0,
            })),
        };
        const repoB = { ...repo, id: 'repo-b', name: 'repository-b' };
        const requests: Array<ReturnType<typeof Promise.withResolvers<GitCommitDetails>>> = [];
        const requestContexts: Array<string | undefined> = [];
        const { git, provider } = createHarness();
        vi.mocked(git.summary)
            .mockResolvedValueOnce(manyRepositories)
            .mockResolvedValueOnce({ isRepository: true, repositories: [repoB] });
        vi.mocked(git.commitDetails).mockImplementation(() => {
            requestContexts.push(context.getStore());
            const request = Promise.withResolvers<GitCommitDetails>();
            requests.push(request);
            return request.promise;
        });
        const cancellation = new CancellationTokenSource();

        await context.run('scope-a', () =>
            provider.provideView(
                { scopeId: 'session-a:project-a', preferredModeId: 'commit', refresh: 0 },
                cancellation.token,
            ),
        );
        await context.run('scope-b', () =>
            provider.provideView(
                { scopeId: 'session-b:project-b', preferredModeId: 'commit', refresh: 0 },
                cancellation.token,
            ),
        );
        expect(requestContexts).toEqual(['scope-a', 'scope-a', 'scope-a', 'scope-a']);
        requests[0].resolve(commitDetails);
        await vi.waitFor(() => expect(git.commitDetails).toHaveBeenCalledTimes(5));
        requests[1].resolve(commitDetails);
        await vi.waitFor(() => expect(git.commitDetails).toHaveBeenCalledTimes(6));
        requests[2].resolve(commitDetails);
        await vi.waitFor(() => expect(git.commitDetails).toHaveBeenCalledTimes(7));

        expect(requestContexts).toEqual([
            'scope-a',
            'scope-a',
            'scope-a',
            'scope-a',
            'scope-a',
            'scope-a',
            'scope-b',
        ]);

        cancellation.dispose();
        provider.dispose();
    });

    it('projects authorized Runtime data into opaque, revision-bound actions', async () => {
        const { git, provider } = createHarness();
        const cancellation = new CancellationTokenSource();

        const view = await provider.provideView(
            { scopeId, preferredModeId: 'working', refresh: 3 },
            cancellation.token,
        );
        const resource = view.providers[0]?.groups[0]?.resources[0];
        const discard = resource.actions?.[0];

        expect(git.summary).toHaveBeenCalledWith(0, cancellation.token);
        expect(view).toMatchObject({
            selectedModeId: 'working',
            providers: [
                {
                    label: 'project',
                    groups: [
                        {
                            label: 'Changes',
                            resources: [{ label: 'extension.ts', description: 'M' }],
                        },
                    ],
                },
            ],
        });
        expect(discard?.id).toMatch(/^action-\d+$/);
        expect(discard?.id).not.toBe(discard?.command.id);

        await provider.runAction(
            { actionId: discard!.id, scopeId, revision: view.revision },
            cancellation.token,
        );
        expect(git.discard).toHaveBeenCalledWith(
            'repo-1',
            { kind: 'file', path: 'src/extension.ts' },
            cancellation.token,
        );
        await expect(
            provider.executeCommand('caxri.git.history', [repo.id], cancellation.token),
        ).resolves.toEqual({ effects: [], refresh: false });
        await expect(
            provider.executeCommand('caxri.git.history', ['missing'], cancellation.token),
        ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });

        cancellation.dispose();
        provider.dispose();
    });

    it('returns an authoritative mutation result when Git invalidation advances its revision', async () => {
        const syncRequest = Promise.withResolvers<void>();
        const { git, provider } = createHarness();
        vi.mocked(git.sync).mockReturnValueOnce(syncRequest.promise);
        const cancellation = new CancellationTokenSource();
        const view = await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        const sync = view.providers[0]?.actions[0];

        const result = provider.runAction(
            { actionId: sync.id, scopeId, revision: view.revision },
            cancellation.token,
        );
        await vi.waitFor(() => expect(git.sync).toHaveBeenCalledOnce());
        provider.refresh(scopeId);
        syncRequest.resolve();

        await expect(result).resolves.toMatchObject({
            revision: view.revision,
            refresh: true,
        });

        cancellation.dispose();
        provider.dispose();
    });

    it('rejects cancelled raw requests before constructing a view model', async () => {
        const pending = Promise.withResolvers<GitSummary>();
        const { getConfiguration, git, provider } = createHarness();
        vi.mocked(git.summary).mockReturnValueOnce(pending.promise);
        const cancellation = new CancellationTokenSource();

        const request = provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        cancellation.cancel();
        pending.resolve(summary);

        await expect(request).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(getConfiguration).not.toHaveBeenCalled();

        cancellation.dispose();
        provider.dispose();
    });

    it('fences superseded snapshot state before publishing history avatars', async () => {
        const firstRemoteHost = Promise.withResolvers<string | null>();
        const { git, provider } = createHarness({ avatars: true });
        vi.mocked(git.remoteHost)
            .mockReturnValueOnce(firstRemoteHost.promise)
            .mockResolvedValueOnce('github.com');
        const cancellation = new CancellationTokenSource();

        const first = await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        const stale = provider.provideHistoryPage(
            {
                historyId: repo.id,
                scopeId,
                offset: 0,
                pageSize: 5,
                revision: first.revision,
            },
            cancellation.token,
        );
        await vi.waitFor(() => expect(git.remoteHost).toHaveBeenCalledTimes(1));
        const current = await provider.provideView({ scopeId, refresh: 1 }, cancellation.token);
        const page = await provider.provideHistoryPage(
            {
                historyId: repo.id,
                scopeId,
                offset: 0,
                pageSize: 5,
                revision: current.revision,
            },
            cancellation.token,
        );
        firstRemoteHost.resolve(null);

        await expect(stale).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
        expect(page.items[0]?.avatarUrl).toBe(
            'https://avatars.githubusercontent.com/u/12345?s=60&v=4',
        );

        cancellation.dispose();
        provider.dispose();
    });

    it('keeps the deepest active-file repository authorized and opens file history commits', async () => {
        const nestedRepo = {
            ...repo,
            id: 'repo-nested',
            kind: 'nested' as const,
            name: 'nested',
            rootPath: '/authorized/project/packages/nested',
        };
        const nestedSummary: GitSummary = {
            isRepository: true,
            repositories: [repo, nestedRepo],
        };
        const { git, provider } = createHarness();
        vi.mocked(git.summary).mockResolvedValue(nestedSummary);
        const cancellation = new CancellationTokenSource();
        await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        await provider.openCommit(scopeId, repo.id, repo.head, cancellation.token);

        const view = await provider.provideView(
            {
                activeResource: '/authorized/project/packages/nested/src/feature.ts',
                scopeId,
                preferredModeId: 'commit',
                refresh: 0,
            },
            cancellation.token,
        );
        const page = await provider.provideHistoryPage(
            {
                historyId: nestedRepo.id,
                itemActivation: 'action',
                scopeId,
                offset: 0,
                pageSize: 5,
                path: 'src/feature.ts',
                revision: view.revision,
            },
            cancellation.token,
        );
        const action = page.items[0]?.action;
        const actionResult = await provider.runAction(
            { actionId: action!.id, scopeId, revision: view.revision },
            cancellation.token,
        );

        expect(view.providers).toHaveLength(1);
        expect(view.fileHistory).toMatchObject({
            path: 'src/feature.ts',
            history: { id: nestedRepo.id },
        });
        expect(git.commits).toHaveBeenCalledWith(
            {
                repositoryId: nestedRepo.id,
                offset: 0,
                pageSize: 5,
                path: 'src/feature.ts',
            },
            expect.anything(),
        );
        expect(actionResult).toEqual({
            revision: view.revision,
            effects: [
                {
                    kind: 'open-editor',
                    resource: `caxri-git-diff://commit-file/${nestedRepo.id}/${commitDetails.commit.sha}/src%2Ffeature.ts`,
                },
            ],
            refresh: false,
        });

        cancellation.dispose();
        provider.dispose();
    });

    it('publishes loading state before cancellable Commit details complete', async () => {
        const pending = Promise.withResolvers<GitCommitDetails>();
        const { git, provider } = createHarness();
        vi.mocked(git.commitDetails).mockReturnValueOnce(pending.promise);
        const cancellation = new CancellationTokenSource();
        const changes: string[] = [];
        const subscription = provider.onDidChange((change) => changes.push(change.kind));

        const loading = await provider.provideView(
            { scopeId, preferredModeId: 'commit', refresh: 0 },
            cancellation.token,
        );
        expect(loading.providers[0]?.groups[0]).toMatchObject({
            emptyMessage: 'Loading last commit…',
            isLoading: true,
            resources: [],
        });
        expect(loading.providers[0]?.history).toBeUndefined();
        pending.resolve(commitDetails);
        await vi.waitFor(() => expect(changes).toContain('content'));
        const ready = await provider.provideView(
            { scopeId, preferredModeId: 'commit', refresh: 0 },
            cancellation.token,
        );
        expect(ready.providers[0].groups[0].resources[0]).toMatchObject({
            label: 'extension.ts',
            description: 'M',
        });
        subscription.dispose();
        cancellation.dispose();
        provider.dispose();
    });

    it('keeps detail loading alive when the mode command repeats the requested mode', async () => {
        const pending = Promise.withResolvers<GitPullRequestChanges | null>();
        const pullRequest: GitPullRequestChanges = {
            repositoryId: repo.id,
            number: 42,
            title: 'Keep the in-flight pull request',
            url: 'https://github.com/example/caxri/pull/42',
            baseRefName: 'main',
            headRefName: 'feature/pull-request',
            baseOid: 'a'.repeat(40),
            headOid: 'b'.repeat(40),
            unpushedCommitCount: 0,
            additions: 5,
            deletions: 2,
            files: [
                {
                    path: 'src/extension.ts',
                    index: 'M',
                    workingTree: ' ',
                    kind: 'modified',
                },
            ],
        };
        const { git, provider } = createHarness();
        vi.mocked(git.pullRequestChanges).mockReturnValueOnce(pending.promise);
        const cancellation = new CancellationTokenSource();
        const changes: string[] = [];
        const subscription = provider.onDidChange((change) => changes.push(change.kind));

        const loading = await provider.provideView(
            { scopeId, preferredModeId: 'pull-request', refresh: 0 },
            cancellation.token,
        );
        const detailToken = vi.mocked(git.pullRequestChanges).mock.calls[0]?.[2];
        provider.setMode('pull-request', scopeId);
        expect(detailToken?.isCancellationRequested).toBe(false);
        pending.resolve(pullRequest);
        await vi.waitFor(() => expect(changes).toContain('content'));
        const ready = await provider.provideView(
            { scopeId, preferredModeId: 'pull-request', refresh: 0 },
            cancellation.token,
        );

        expect(loading.providers[0]?.groups[0]).toMatchObject({
            emptyMessage: 'Loading pull request changes…',
            isLoading: true,
        });
        expect(ready.providers[0]?.groups[0]).toMatchObject({ label: 'PR #42 Changes' });
        expect(ready.providers[0]?.groups[0]?.isLoading).toBeUndefined();

        subscription.dispose();
        cancellation.dispose();
        provider.dispose();
    });

    it.each([
        { refreshKind: 'panel', outcome: 'empty' },
        { refreshKind: 'watcher', outcome: 'updated' },
        { refreshKind: 'panel', outcome: 'error' },
        { refreshKind: 'watcher', outcome: 'branch' },
        { refreshKind: 'mode-command', outcome: 'updated' },
        { refreshKind: 'mode-query', outcome: 'updated' },
    ])(
        'retains PR content during $refreshKind refresh until $outcome',
        async ({ refreshKind, outcome }) => {
            const { git, provider } = createHarness();
            const cancellation = new CancellationTokenSource();
            const pullRequest: GitPullRequestChanges = {
                repositoryId: repo.id,
                number: 42,
                title: 'Refresh without clearing files',
                url: 'https://github.com/example/caxri/pull/42',
                baseRefName: 'main',
                headRefName: repo.branch,
                baseOid: 'a'.repeat(40),
                headOid: repo.head,
                unpushedCommitCount: 0,
                additions: 5,
                deletions: 2,
                files: repo.files,
            };
            const request = { scopeId, preferredModeId: 'pull-request', refresh: 0 };
            vi.mocked(git.pullRequestChanges).mockResolvedValueOnce(pullRequest);
            await provider.provideView(request, cancellation.token);
            await new Promise((resolve) => setImmediate(resolve));
            const ready = await provider.provideView(request, cancellation.token);
            const pending = Promise.withResolvers<GitPullRequestChanges | null>();
            vi.mocked(git.pullRequestChanges).mockReturnValueOnce(pending.promise);
            if (refreshKind.startsWith('mode-')) {
                if (refreshKind === 'mode-command') provider.setMode('working', scopeId);
                await provider.provideView(
                    { ...request, preferredModeId: 'working' },
                    cancellation.token,
                );
                if (refreshKind === 'mode-command') provider.setMode('pull-request', scopeId);
            } else if (refreshKind === 'watcher') provider.refresh(scopeId);
            else request.refresh += 1;
            const refreshing = await provider.provideView(request, cancellation.token);
            expect(refreshing.providers[0]?.groups[0]).toMatchObject({
                label: 'PR #42 Changes',
                resources: ready.providers[0].groups[0].resources.map(({ label, description }) => ({
                    label,
                    description,
                })),
            });
            if (outcome === 'branch') {
                vi.mocked(git.summary).mockResolvedValue({
                    ...summary,
                    repositories: [{ ...repo, branch: 'other-branch' }],
                });
                const next = Promise.withResolvers<GitPullRequestChanges | null>();
                vi.mocked(git.pullRequestChanges).mockReturnValueOnce(next.promise);
                const switched = await provider.provideView(request, cancellation.token);
                expect(switched.providers[0]?.groups[0]).toMatchObject({
                    resources: [],
                    emptyMessage: 'Loading pull request changes…',
                });
                pending.resolve(pullRequest);
                next.resolve(null);
            } else if (outcome === 'error') pending.reject(new Error('Refresh failed'));
            else pending.resolve(outcome === 'updated' ? { ...pullRequest, number: 43 } : null);
            await new Promise((resolve) => setImmediate(resolve));
            const updated = await provider.provideView(request, cancellation.token);
            if (outcome === 'updated') {
                expect(updated.providers[0]?.groups[0]?.label).toBe('PR #43 Changes');
            } else expect(updated.providers[0]?.groups[0]?.resources).toEqual([]);
            if (outcome === 'error') {
                expect(updated.providers[0]?.groups[0]?.emptyMessage).toBe(
                    'Unable to load pull request changes. Refresh to retry.',
                );
            }
            expect(updated.providers[0]?.groups[0]?.label).not.toBe('PR #42 Changes');
            cancellation.dispose();
            provider.dispose();
        },
    );

    it('cancels superseded background details without publishing stale content', async () => {
        const pending = Promise.withResolvers<GitCommitDetails>();
        const { git, provider } = createHarness();
        vi.mocked(git.commitDetails).mockReturnValueOnce(pending.promise);
        const cancellation = new CancellationTokenSource();
        const changes: string[] = [];
        const subscription = provider.onDidChange((change) => changes.push(change.kind));

        await provider.provideView(
            { scopeId, preferredModeId: 'commit', refresh: 0 },
            cancellation.token,
        );
        const detailToken = vi.mocked(git.commitDetails).mock.calls[0]?.[1];
        provider.refresh(scopeId);
        pending.resolve(commitDetails);
        await new Promise((resolve) => setImmediate(resolve));

        expect(detailToken?.isCancellationRequested).toBe(true);
        expect(changes).toEqual(['refresh']);

        subscription.dispose();
        cancellation.dispose();
        provider.dispose();
    });

    it('expires action capabilities and history targets with the provider revision', async () => {
        const { provider } = createHarness();
        const cancellation = new CancellationTokenSource();
        const view = await provider.provideView({ scopeId, refresh: 0 }, cancellation.token);
        const action = view.providers[0]?.groups[0]?.resources[0]?.action;

        provider.refresh(scopeId);

        await expect(
            provider.runAction(
                { actionId: action!.id, scopeId, revision: view.revision },
                cancellation.token,
            ),
        ).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });
        await expect(
            provider.provideHistoryPage(
                {
                    historyId: repo.id,
                    scopeId,
                    offset: 0,
                    pageSize: 5,
                    revision: view.revision,
                },
                cancellation.token,
            ),
        ).rejects.toMatchObject({ code: 'GENERATION_EXPIRED' });

        cancellation.dispose();
        provider.dispose();
    });

    it('publishes a generic scoped selection request for command-driven mode changes', () => {
        const { provider } = createHarness();
        const changes: unknown[] = [];
        const subscription = provider.onDidChange((change) => changes.push(change));

        provider.setMode('commit');
        provider.setMode('commit');
        provider.refresh();

        expect(changes).toEqual([
            { kind: 'selection', selectedModeId: 'commit' },
            { kind: 'selection', selectedModeId: 'commit' },
            { kind: 'refresh' },
        ]);

        subscription.dispose();
        provider.dispose();
    });
});
