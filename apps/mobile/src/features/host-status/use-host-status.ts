import { useCallback, useMemo } from 'react';

import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';

import { useMobileClient } from '../connection/mobile-client-provider';
import { HOST_STATUS_POLL_MS } from './host-status-model';

const hostStatusQueryKey = (scope: string) => ['mobile', 'host-status', scope] as const;

/**
 * The paired computer's live load, re-read every {@link HOST_STATUS_POLL_MS} only while this screen is focused, the app
 * is in the foreground, and the connection is up. Opening a Session from the list stops the polling until the user
 * comes back.
 */
export const useHostStatus = () => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const isFocused = useIsFocused();
    const scope = connectionScopeKey ?? 'unpaired';
    const queryKey = useMemo(() => hostStatusQueryKey(scope), [scope]);
    const isObservable = connectionScopeKey !== null && isForeground && status === 'connected';
    const query = useQuery({
        enabled: isObservable && isFocused,
        gcTime: 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.host.status', {}),
        queryKey,
        refetchInterval: isObservable && isFocused ? HOST_STATUS_POLL_MS : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    const { refetch } = query;
    const refresh = useCallback(async (): Promise<void> => {
        if (isObservable) await refetch();
    }, [isObservable, refetch]);
    return { isObservable, query, refresh };
};
