import { useEffect, useMemo } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { sessionPullRequestQueryKey } from '../pull-request/use-session-pull-request';
import { useReadCache } from '../read-cache/read-cache-context';
import type { PanelsList } from './saved-panels';
import {
    cachedPanelsSchema,
    panelQueryKey,
    panelsListQueryKey,
    seedSavedPanels,
} from './saved-panels';
import { readTreeChildren } from './tree-children-read';
import { refreshTreeThenPullRequest } from './tree-refresh';

export type Panel = PanelsList['panels'][number];

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

/**
 * The Desktop's view list, shared by every Session of this pairing (see {@link panelsListQueryKey}). Each live read is
 * saved on the phone so the next launch can show the view tabs before it connects (see {@link useSavedPanels}).
 */
const usePanelsList = (sessionId: string) => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const readCache = useReadCache();
    return useQuery({
        enabled: connectionScopeKey !== null && isForeground && status === 'connected',
        // A few views per pairing; kept so a Session opened later still finds them without a read.
        gcTime: Infinity,
        networkMode: 'always',
        queryFn: async () => {
            const result = await request('mobile.panels.list', { sessionId });
            if (connectionScopeKey !== null)
                readCache.save(connectionScopeKey, { kind: 'panels' }, result);
            return result;
        },
        queryKey: panelsListQueryKey(connectionScopeKey),
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 15_000,
    });
};

/**
 * Seeds the view list this pairing saved into the query cache once per launch or pairing change, ahead of any Session
 * being opened.
 */
export const useSavedPanels = (): void => {
    const { connectionScopeKey } = useMobileClient();
    const readCache = useReadCache();
    const queryClient = useQueryClient();
    useEffect(() => {
        if (connectionScopeKey === null) return;
        let isActive = true;
        void readCache
            .load(connectionScopeKey, { kind: 'panels' }, cachedPanelsSchema)
            .then((entry) => {
                if (isActive && entry) seedSavedPanels(queryClient, connectionScopeKey, entry);
            });
        return () => {
            isActive = false;
        };
    }, [connectionScopeKey, queryClient, readCache]);
};

export const useTreeChildren = (
    sessionId: string,
    viewId: string,
    parentHandle?: string,
    ancestorHandles: readonly string[] = [],
) => {
    const { connectionScopeKey, request } = useMobileClient();
    const queryClient = useQueryClient();
    return usePanelRead(['tree', sessionId, viewId, parentHandle ?? null], () =>
        readTreeChildren({
            ancestorHandles,
            onLevelSnapshot: (levelHandle, level) =>
                queryClient.setQueryData(
                    panelQueryKey(connectionScopeKey, [
                        'tree',
                        sessionId,
                        viewId,
                        levelHandle ?? null,
                    ]),
                    level,
                ),
            parentHandle,
            read: (levelHandle) =>
                request('mobile.tree.children', {
                    sessionId,
                    viewId,
                    ...(levelHandle !== undefined && { parentHandle: levelHandle }),
                }),
        }),
    );
};

/**
 * Keeps the extension tree this Session shows current: each `extensionViews.changed` hint re-reads the tree queries in
 * place. Rows stay on screen while the read runs, so scroll position and expanded state survive and no loading state
 * appears; a failed re-read keeps the last rows and the next hint or a pull-to-retry tries again. The header's pull
 * request re-reads after the tree, because the Status panel changes when it does (see
 * {@link refreshTreeThenPullRequest}).
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
        const refresh = (): Promise<void> =>
            refreshTreeThenPullRequest(
                queryClient,
                queryKey,
                sessionPullRequestQueryKey(connectionScopeKey, sessionId),
            );
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
                            void refresh();
                    },
                );
                if (isDisposed) {
                    await acquired.unsubscribe();
                    return;
                }
                watch.handle = acquired;
                // Close the gap between the first read and the subscription becoming active.
                void refresh();
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
