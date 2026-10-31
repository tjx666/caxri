import { useEffect, useMemo } from 'react';

import type { MethodResult } from '@caxri/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { sessionPullRequestQueryKey } from '../pull-request/use-session-pull-request';
import { readTreeChildren } from './tree-children-read';

export type Panel = MethodResult<'mobile.panels.list'>['panels'][number];

const panelQueryKey = (connectionScopeKey: string | null, key: readonly unknown[]) => [
    'mobile',
    'panels',
    connectionScopeKey ?? 'unpaired',
    ...key,
];

/**
 * Every Panels read is a one-shot, read-only request. Only the extension tree subscribes (see
 * {@link useExtensionTreeSubscription}); Files and file previews change only on Refresh or re-entering a view.
 */
const usePanelRead = <Result>(
    key: readonly unknown[],
    read: () => Promise<Result>,
    isEnabled = true,
) => {
    const { connectionScopeKey, isForeground, status } = useMobileClient();
    return useQuery({
        enabled: isEnabled && connectionScopeKey !== null && isForeground && status === 'connected',
        gcTime: 5 * 60_000,
        networkMode: 'always',
        queryFn: read,
        queryKey: panelQueryKey(connectionScopeKey, key),
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 15_000,
    });
};

const usePanelsList = (sessionId: string) => {
    const { request } = useMobileClient();
    return usePanelRead(['list', sessionId], () => request('mobile.panels.list', { sessionId }));
};

export const useTreeChildren = (sessionId: string, viewId: string, parentHandle?: string) => {
    const { connectionScopeKey, request } = useMobileClient();
    const queryClient = useQueryClient();
    return usePanelRead(['tree', sessionId, viewId, parentHandle ?? null], () =>
        readTreeChildren({
            onRootSnapshot: (root) =>
                queryClient.setQueryData(
                    panelQueryKey(connectionScopeKey, ['tree', sessionId, viewId, null]),
                    root,
                ),
            parentHandle,
            read: () =>
                request('mobile.tree.children', {
                    sessionId,
                    viewId,
                    ...(parentHandle !== undefined && { parentHandle }),
                }),
        }),
    );
};

/**
 * Keeps the extension tree this Session shows current: each `extensionViews.changed` hint re-reads the tree queries in
 * place. Rows stay on screen while the read runs, so scroll position and expanded state survive and no loading state
 * appears; a failed re-read keeps the last rows and the next hint or a pull-to-retry tries again. The same hint
 * re-reads the header's pull request, because the Status panel changes when it does: a row's `Merge` lands in the
 * Server's status cache only after its command returns, so a re-read at that moment would still see the open pull
 * request.
 */
export const useExtensionTreeSubscription = (sessionId: string) => {
    const { connectionScopeKey, isForeground, status, subscribe, subscriptionAvailable } =
        useMobileClient();
    const queryClient = useQueryClient();
    const isObservable = connectionScopeKey !== null && isForeground && status === 'connected';
    useEffect(() => {
        if (!isObservable || !subscriptionAvailable) return;
        const queryKey = ['mobile', 'panels', connectionScopeKey, 'tree', sessionId];
        let isDisposed = false;
        const watch: { handle: Awaited<ReturnType<typeof subscribe>> | null } = { handle: null };
        const refresh = (): void => {
            void queryClient.invalidateQueries({ queryKey });
            void queryClient.invalidateQueries({
                exact: true,
                queryKey: sessionPullRequestQueryKey(connectionScopeKey, sessionId),
            });
        };
        const attach = async (): Promise<void> => {
            try {
                const acquired = await subscribe(
                    { kind: 'extensionViews', sessionId },
                    (message) => {
                        if (
                            !isDisposed &&
                            (message.kind === 'extensionViews.changed' ||
                                message.kind === 'resync-required')
                        )
                            refresh();
                    },
                );
                if (isDisposed) {
                    await acquired.unsubscribe();
                    return;
                }
                watch.handle = acquired;
                // Close the gap between the first read and the subscription becoming active.
                refresh();
            } catch {
                // Without a subscription the tree keeps its one-shot reads; Refresh and re-entering still work.
            }
        };
        void attach();
        return () => {
            isDisposed = true;
            if (watch.handle) void watch.handle.unsubscribe();
        };
    }, [
        connectionScopeKey,
        isObservable,
        queryClient,
        sessionId,
        subscribe,
        subscriptionAvailable,
    ]);
};

export const useFilesList = (sessionId: string, directory?: string) => {
    const { request } = useMobileClient();
    return usePanelRead(['files', sessionId, directory ?? null], () =>
        request('mobile.files.list', {
            sessionId,
            ...(directory !== undefined && { directory }),
        }),
    );
};

export const useFileRead = (sessionId: string, path: string | null) => {
    const { request } = useMobileClient();
    return usePanelRead(
        ['file', sessionId, path],
        () => request('mobile.files.read', { sessionId, path: path! }),
        path !== null,
    );
};

/**
 * Desktop's Git view is left out: the Session's Changes tab already shows the same data, and a second entry would read
 * as a different view.
 */
const withoutChanges = (panels: readonly Panel[]): Panel[] =>
    panels
        .map((panel) => ({
            ...panel,
            views: panel.views.filter((view) => view.kind !== 'changes'),
        }))
        .filter((panel) => panel.views.length > 0);

/**
 * The Project views this Session can open on the phone, in Desktop's sidebar order. Each becomes a top-level Session
 * tab.
 */
export const useSessionPanels = (sessionId: string) => {
    const query = usePanelsList(sessionId);
    const panels = useMemo(
        () => (query.data ? withoutChanges(query.data.panels) : undefined),
        [query.data],
    );
    return { panels, query };
};
