import type { SourceControlViewModel } from '@caxri/protocol';
import { gitFileDiffTabPath } from '@caxri/protocol';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { invalidateControlledViewSnapshotQueries } from '../../view-operation-client';
import {
    buildSourceControlSnapshotRequest,
    sourceControlSnapshotQueryOptions,
} from '../hooks/use-source-control-controller';

function model(revision: string, selectedModeId = 'working'): SourceControlViewModel {
    return {
        accessibilityLabel: 'Git repositories',
        modeAccessibilityLabel: 'Source control mode',
        modes: [],
        providers: [],
        refreshAction: {
            command: { id: 'caxri.git.refresh' },
            icon: { kind: 'theme', id: 'refresh' },
            id: 'refresh',
            label: 'Refresh Git',
        },
        revision,
        selectedModeId,
        title: 'Source Control',
    };
}

describe('Source Control snapshot queries', () => {
    it('requests history context only for the active file resource', () => {
        expect(
            buildSourceControlSnapshotRequest(
                { kind: 'file', path: '/project/file.ts' },
                'working',
            ),
        ).toEqual({
            activeResource: '/project/file.ts',
            preferredModeId: 'working',
        });
        expect(
            buildSourceControlSnapshotRequest(
                { kind: 'terminal', terminalId: 'terminal-1' },
                'working',
            ),
        ).toEqual({ preferredModeId: 'working' });
        expect(
            buildSourceControlSnapshotRequest(
                { kind: 'file', path: gitFileDiffTabPath('repo-1', 'src/file.ts') },
                'working',
            ),
        ).toEqual({ preferredModeId: 'working' });
    });

    it('keeps one cache identity for forced refreshes and still sends the nonce', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const pending = Promise.withResolvers<SourceControlViewModel>();
        const initial = model('1');
        const refreshed = model('2');
        const snapshot = vi
            .fn<
                (
                    request: { refresh: number },
                    signal?: AbortSignal,
                ) => Promise<SourceControlViewModel>
            >()
            .mockResolvedValueOnce(initial)
            .mockReturnValueOnce(pending.promise);
        const options = (refresh: number) =>
            sourceControlSnapshotQueryOptions({
                client: { snapshot },
                configRevision: '[]',
                enabled: true,
                queryScope: 'session-1:project-1',
                refresh,
                request: { activeResource: '/project/file.ts' },
                viewId: 'caxri.git.sourceControl',
            });
        expect(options(99).queryKey).toEqual(options(0).queryKey);
        const observer = new QueryObserver(queryClient, options(0));
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(initial));
            expect(snapshot.mock.calls[0]?.[0]).toMatchObject({
                activeResource: '/project/file.ts',
                refresh: 0,
            });

            observer.setOptions(options(4));
            const refetch = observer.refetch();
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));

            expect(snapshot.mock.calls[1]?.[0]).toMatchObject({
                activeResource: '/project/file.ts',
                refresh: 4,
            });
            expect(observer.getCurrentResult()).toMatchObject({
                data: initial,
                isFetching: true,
                isPlaceholderData: false,
            });

            pending.resolve(refreshed);
            await refetch;
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(refreshed));
        } finally {
            unsubscribe();
            queryClient.clear();
        }
    });

    it('exposes a same-key cached refetch as active without placeholder data', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const pending = Promise.withResolvers<SourceControlViewModel>();
        const initial = model('1');
        const refreshed = model('2');
        const snapshot = vi
            .fn<() => Promise<SourceControlViewModel>>()
            .mockResolvedValueOnce(initial)
            .mockReturnValueOnce(pending.promise);
        const options = sourceControlSnapshotQueryOptions({
            client: { snapshot },
            configRevision: '[]',
            enabled: true,
            queryScope: 'session-1:project-1',
            request: {},
            viewId: 'caxri.git.sourceControl',
        });
        const observer = new QueryObserver(queryClient, options);
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(initial));

            const refetch = observer.refetch();
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));

            expect(observer.getCurrentResult()).toMatchObject({
                data: initial,
                isFetching: true,
                isPlaceholderData: false,
            });

            pending.resolve(refreshed);
            await refetch;
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(refreshed));
        } finally {
            unsubscribe();
            queryClient.clear();
        }
    });

    it('keeps the labeled previous model mounted while a mode switch is pending', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const pending = Promise.withResolvers<SourceControlViewModel>();
        const initial = model('1');
        const snapshot = vi
            .fn<() => Promise<SourceControlViewModel>>()
            .mockResolvedValueOnce(initial)
            .mockReturnValueOnce(pending.promise);
        const client = { snapshot };
        const options = (preferredModeId: string) =>
            sourceControlSnapshotQueryOptions({
                client,
                configRevision: '[]',
                enabled: true,
                queryScope: 'session-1:project-1',
                request: { preferredModeId },
                viewId: 'caxri.git.sourceControl',
            });
        const observer = new QueryObserver(queryClient, options('working'));
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(initial));

            observer.setOptions(options('commit'));

            expect(observer.getCurrentResult()).toMatchObject({
                data: initial,
                isFetching: true,
                isPlaceholderData: true,
            });
            const next = model('2', 'commit');
            pending.resolve(next);
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(next));
        } finally {
            unsubscribe();
            queryClient.clear();
        }
    });

    it('does not present the previous file while an active-file switch is pending', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const pending = Promise.withResolvers<SourceControlViewModel>();
        const initial = model('1');
        const snapshot = vi
            .fn<() => Promise<SourceControlViewModel>>()
            .mockResolvedValueOnce(initial)
            .mockReturnValueOnce(pending.promise);
        const client = { snapshot };
        const options = (activeResource: string) =>
            sourceControlSnapshotQueryOptions({
                client,
                configRevision: '[]',
                enabled: true,
                queryScope: 'session-1:project-1',
                request: { activeResource, preferredModeId: 'working' },
                viewId: 'caxri.git.sourceControl',
            });
        const observer = new QueryObserver(queryClient, options('/project/first.ts'));
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(initial));

            observer.setOptions(options('/project/second.ts'));

            expect(observer.getCurrentResult()).toMatchObject({
                data: undefined,
                isFetching: true,
                isPlaceholderData: false,
            });
        } finally {
            unsubscribe();
            queryClient.clear();
        }
    });

    it('refreshes a cached file snapshot before reusing its revision', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false, staleTime: 10_000 } },
        });
        const pending = Promise.withResolvers<SourceControlViewModel>();
        const firstRoot = model('1');
        const nested = model('2');
        const currentRoot = model('3');
        const snapshot = vi
            .fn<() => Promise<SourceControlViewModel>>()
            .mockResolvedValueOnce(firstRoot)
            .mockResolvedValueOnce(nested)
            .mockReturnValueOnce(pending.promise);
        const options = (activeResource: string) =>
            sourceControlSnapshotQueryOptions({
                client: { snapshot },
                configRevision: '[]',
                enabled: true,
                queryScope: 'session-1:project-1',
                request: { activeResource, preferredModeId: 'working' },
                viewId: 'caxri.git.sourceControl',
            });
        const observer = new QueryObserver(queryClient, options('/project/root.ts'));
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(firstRoot));
            observer.setOptions(options('/project/nested/file.ts'));
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(nested));

            observer.setOptions(options('/project/root.ts'));
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(3));
            expect(observer.getCurrentResult()).toMatchObject({
                data: firstRoot,
                isFetching: true,
            });

            pending.resolve(currentRoot);
            await vi.waitFor(() =>
                expect(observer.getCurrentResult().data?.revision).toBe(currentRoot.revision),
            );
        } finally {
            unsubscribe();
            queryClient.clear();
        }
    });

    it('keeps a provider fallback visible when the same unavailable mode refreshes', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const pending = Promise.withResolvers<SourceControlViewModel>();
        const fallback = model('1', 'working');
        const snapshot = vi
            .fn<() => Promise<SourceControlViewModel>>()
            .mockResolvedValueOnce(fallback)
            .mockReturnValueOnce(pending.promise);
        const client = { snapshot };
        const options = sourceControlSnapshotQueryOptions({
            client,
            configRevision: '[]',
            enabled: true,
            queryScope: 'session-1:project-1',
            request: { preferredModeId: 'retired-mode' },
            viewId: 'caxri.git.sourceControl',
        });
        const observer = new QueryObserver(queryClient, options);
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(fallback));

            const refetch = observer.refetch();
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));

            expect(observer.getCurrentResult()).toMatchObject({
                data: fallback,
                isFetching: true,
                isPlaceholderData: false,
            });

            pending.resolve(fallback);
            await refetch;
        } finally {
            unsubscribe();
            queryClient.clear();
        }
    });

    it('abandons a cold in-flight snapshot so a bumped refresh nonce reaches Server', async () => {
        const queryClient = new QueryClient({
            defaultOptions: { queries: { retry: false } },
        });
        const pending = Promise.withResolvers<SourceControlViewModel>();
        const snapshot = vi
            .fn<
                (
                    request: { refresh: number },
                    signal?: AbortSignal,
                ) => Promise<SourceControlViewModel>
            >()
            .mockReturnValueOnce(pending.promise)
            .mockResolvedValueOnce(model('2'));
        const options = (refresh: number) =>
            sourceControlSnapshotQueryOptions({
                client: { snapshot },
                configRevision: '[]',
                enabled: true,
                queryScope: 'session-1:project-1',
                refresh,
                request: { activeResource: '/project/file.ts' },
                viewId: 'caxri.git.sourceControl',
            });
        const observer = new QueryObserver(queryClient, options(0));
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(1));
            expect(snapshot.mock.calls[0]?.[0]).toMatchObject({ refresh: 0 });

            observer.setOptions(options(1));
            const refresh = invalidateControlledViewSnapshotQueries(
                queryClient,
                'caxri.git.sourceControl',
            );
            await vi.waitFor(() => expect(snapshot).toHaveBeenCalledTimes(2));
            expect(snapshot.mock.calls[1]?.[0]).toMatchObject({ refresh: 1 });
            await refresh;
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toEqual(model('2')));
        } finally {
            pending.resolve(model('1'));
            unsubscribe();
            queryClient.clear();
        }
    });
});
