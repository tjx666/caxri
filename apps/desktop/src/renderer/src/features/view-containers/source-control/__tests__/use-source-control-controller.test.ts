import type { SourceControlViewModel } from '@caxri/protocol';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

import { sourceControlSnapshotQueryOptions } from '../hooks/use-source-control-controller';

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
    it('keeps the resolved tree visible while a same-mode refresh is pending', async () => {
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
        const client = { snapshot };
        const options = (refresh: number) =>
            sourceControlSnapshotQueryOptions({
                client,
                configRevision: '[]',
                enabled: true,
                queryScope: 'session-1:project-1',
                request: { refresh },
                viewId: 'caxri.git.sourceControl',
            });
        const observer = new QueryObserver(queryClient, options(0));
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(initial));

            observer.setOptions(options(1));

            expect(observer.getCurrentResult()).toMatchObject({
                data: initial,
                isFetching: true,
                isPlaceholderData: true,
            });

            pending.resolve(refreshed);
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(refreshed));
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
            request: { refresh: 0 },
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

    it('does not present the previous mode while a mode switch is pending', async () => {
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
                request: { preferredModeId, refresh: 0 },
                viewId: 'caxri.git.sourceControl',
            });
        const observer = new QueryObserver(queryClient, options('working'));
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(initial));

            observer.setOptions(options('commit'));

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
        const options = (refresh: number) =>
            sourceControlSnapshotQueryOptions({
                client,
                configRevision: '[]',
                enabled: true,
                queryScope: 'session-1:project-1',
                request: { preferredModeId: 'retired-mode', refresh },
                viewId: 'caxri.git.sourceControl',
            });
        const observer = new QueryObserver(queryClient, options(0));
        const unsubscribe = observer.subscribe(() => {});

        try {
            await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe(fallback));

            observer.setOptions(options(1));

            expect(observer.getCurrentResult()).toMatchObject({
                data: fallback,
                isFetching: true,
                isPlaceholderData: true,
            });
        } finally {
            unsubscribe();
            queryClient.clear();
        }
    });
});
