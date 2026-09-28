import { useMemo } from 'react';

import type { MethodResult } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';

export type Panel = MethodResult<'mobile.panels.list'>['panels'][number];

/**
 * Every Panels read is a one-shot, read-only request: nothing here subscribes, so Refresh or re-entering a view is how
 * the reader sees newer state.
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
        queryKey: ['mobile', 'panels', connectionScopeKey ?? 'unpaired', ...key],
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
    const { request } = useMobileClient();
    return usePanelRead(['tree', sessionId, viewId, parentHandle ?? null], () =>
        request('mobile.tree.children', {
            sessionId,
            viewId,
            ...(parentHandle !== undefined && { parentHandle }),
        }),
    );
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
