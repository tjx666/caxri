import { useEffect, useMemo, useRef, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import type { ChangedFile, ChangesMode } from './changes-model';
import { readChangesSnapshot } from './changes-query';

const changesQueryKey = (scope: string, sessionId: string) =>
    ['mobile', 'changes', scope, sessionId] as const;

/**
 * One Changes mode's file list. The Working Tree list owns the `changes` subscription; its events invalidate every mode
 * and open diff under the Session key, so a commit or pull request list read beside it passes `shouldSubscribe: false`
 * instead of opening a second subscription to the same events.
 */
export const useChangesList = (
    isEnabled: boolean,
    sessionId: string,
    mode: ChangesMode = 'working',
    { shouldSubscribe = true }: { shouldSubscribe?: boolean } = {},
) => {
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
    const sessionKey = useMemo(() => changesQueryKey(scope, sessionId), [scope, sessionId]);
    const queryKey = useMemo(() => [...sessionKey, 'list', mode] as const, [mode, sessionKey]);
    const observable =
        isEnabled && connectionScopeKey !== null && isForeground && status === 'connected';
    const [subscription, setSubscription] = useState<{ identity: string; active: boolean }>({
        identity: '',
        active: false,
    });
    const identity = `${scope}:${sessionId}:${mode}:${connectionEpoch}`;
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
        queryFn: () => readChangesSnapshot(request, sessionId, false, mode),
        queryKey,
        // Only the Working Tree list polls without a subscription: commit and pull request lists change with HEAD, which
        // the Working Tree subscription or poll already reports, and a pull request read can reach GitHub.
        refetchInterval: observable && shouldSubscribe && !hasSubscription ? 2_500 : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    useEffect(() => {
        if (!observable || !subscriptionAvailable || !shouldSubscribe) return;
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
                    void queryClient.invalidateQueries({ queryKey: sessionKey, exact: false });
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
                void queryClient.invalidateQueries({ queryKey: sessionKey, exact: false });
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
    }, [
        identity,
        observable,
        queryClient,
        sessionId,
        sessionKey,
        shouldSubscribe,
        subscribe,
        subscriptionAvailable,
    ]);
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
                    const snapshot = await readChangesSnapshot(request, sessionId, true, mode);
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

export const useChangesDiff = (
    isEnabled: boolean,
    sessionId: string,
    file: ChangedFile | null,
    mode: ChangesMode = 'working',
) => {
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
                ...(mode !== 'working' && { mode }),
            }),
        queryKey: [
            ...changesQueryKey(connectionScopeKey ?? 'unpaired', sessionId),
            'diff',
            mode,
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
