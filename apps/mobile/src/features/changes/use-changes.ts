import { useEffect, useMemo, useRef, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import type { ChangedFile } from './changes-model';
import { readChangesSnapshot } from './changes-query';

const changesQueryKey = (scope: string, sessionId: string) =>
    ['mobile', 'changes', scope, sessionId] as const;

export const useChangesList = (isEnabled: boolean, sessionId: string) => {
    const {
        connectionEpoch,
        connectionScopeKey,
        isForeground,
        request,
        status,
        subscribe,
        subscriptionAvailable,
    } = useMobileClient();
    const queryClient = useQueryClient();
    const scope = connectionScopeKey ?? 'unpaired';
    const queryKey = useMemo(() => changesQueryKey(scope, sessionId), [scope, sessionId]);
    const observable =
        isEnabled && connectionScopeKey !== null && isForeground && status === 'connected';
    const [subscription, setSubscription] = useState<{ identity: string; active: boolean }>({
        identity: '',
        active: false,
    });
    const identity = `${scope}:${sessionId}:${connectionEpoch}`;
    const manualRefreshInFlight = useRef(new Set<string>());
    const [manualRefreshingIdentity, setManualRefreshingIdentity] = useState<string | null>(null);
    const [manualFailureIdentities, setManualFailureIdentities] = useState<Set<string>>(
        () => new Set(),
    );
    const isManualRefreshing = manualRefreshingIdentity === identity;
    const hasManualRefreshError = manualFailureIdentities.has(identity);
    const hasSubscription = subscription.identity === identity && subscription.active;
    const query = useQuery({
        enabled: observable,
        gcTime: 5 * 60_000,
        networkMode: 'always',
        queryFn: () => readChangesSnapshot(request, sessionId),
        queryKey,
        refetchInterval: observable && !hasSubscription ? 2_500 : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    useEffect(() => {
        if (!observable || !subscriptionAvailable) return;
        let isDisposed = false;
        let isResyncRequired = false;
        let handle: Awaited<ReturnType<typeof subscribe>> | null = null;
        const attach = async (): Promise<void> => {
            try {
                const acquired = await subscribe({ kind: 'changes', sessionId }, (message) => {
                    if (
                        isDisposed ||
                        (message.kind !== 'changes.changed' && message.kind !== 'resync-required')
                    )
                        return;
                    void queryClient.invalidateQueries({ queryKey, exact: false });
                    if (message.kind === 'resync-required') {
                        isResyncRequired = true;
                        setSubscription({ identity, active: false });
                    }
                });
                if (isDisposed) {
                    await acquired.unsubscribe();
                    return;
                }
                handle = acquired;
                setSubscription({ identity, active: !isResyncRequired });
                // Close the subscribe-before-snapshot gap.
                void queryClient.invalidateQueries({ queryKey, exact: false });
            } catch {
                if (!isDisposed) setSubscription({ identity, active: false });
            }
        };
        void attach();
        return () => {
            isDisposed = true;
            setSubscription({ identity, active: false });
            if (handle) void handle.unsubscribe();
        };
    }, [identity, observable, queryClient, queryKey, sessionId, subscribe, subscriptionAvailable]);
    return {
        state: {
            error: query.isError || hasManualRefreshError,
            isLoading: observable && query.isPending,
            isRefreshing:
                observable &&
                (isManualRefreshing || (query.isFetching && query.data !== undefined)),
            isStale: !observable,
            snapshot: query.data ?? null,
        },
        refresh: () => {
            if (!observable || manualRefreshInFlight.current.has(identity)) return;
            manualRefreshInFlight.current.add(identity);
            setManualRefreshingIdentity(identity);
            const force = async (): Promise<void> => {
                try {
                    // Cancel an older Query read so it cannot replace the post-click forced snapshot.
                    await queryClient.cancelQueries({ queryKey, exact: true });
                    const snapshot = await readChangesSnapshot(request, sessionId, true);
                    await queryClient.cancelQueries({ queryKey, exact: true });
                    queryClient.setQueryData(queryKey, snapshot);
                    setManualFailureIdentities((current) => {
                        const next = new Set(current);
                        next.delete(identity);
                        return next;
                    });
                } catch {
                    setManualFailureIdentities((current) => new Set(current).add(identity));
                } finally {
                    manualRefreshInFlight.current.delete(identity);
                    setManualRefreshingIdentity((current) =>
                        current === identity ? null : current,
                    );
                }
            };
            void force();
        },
    };
};

export const useChangesDiff = (isEnabled: boolean, sessionId: string, file: ChangedFile | null) => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const observable =
        isEnabled &&
        file !== null &&
        connectionScopeKey !== null &&
        isForeground &&
        status === 'connected';
    const query = useQuery({
        enabled: observable,
        gcTime: 0,
        networkMode: 'always',
        queryFn: () =>
            request('mobile.changes.diff', {
                sessionId,
                repositoryId: file!.repositoryId,
                path: file!.path,
            }),
        queryKey: [
            ...changesQueryKey(connectionScopeKey ?? 'unpaired', sessionId),
            'diff',
            file?.repositoryId,
            file?.path,
        ],
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    return {
        state: {
            error: query.isError,
            isDisconnected: !observable,
            isLoading: observable && query.isPending,
            patch: query.data?.status === 'available' ? query.data.patch : null,
            stale: !observable || query.data?.status === 'stale',
            unavailable: query.data?.status === 'binary' || query.data?.status === 'oversized',
        },
        refresh: () => {
            if (observable) void query.refetch();
        },
    };
};
