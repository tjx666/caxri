import { useMemo } from 'react';

import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { buildMobileSessionSections } from '../session-model';
import { allMobileSessions } from './use-session-polling';

export const useSessionShow = (sessionId: string | null, shouldFetch: boolean) => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const query = useQuery({
        enabled:
            sessionId !== null &&
            shouldFetch &&
            connectionScopeKey !== null &&
            isForeground &&
            status === 'connected',
        gcTime: 0,
        networkMode: 'always',
        queryFn: () => request('mobile.session.show', { sessionId: sessionId! }),
        queryKey: ['mobile', 'session', connectionScopeKey ?? 'unpaired', sessionId],
        refetchInterval: shouldFetch ? 2_500 : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    const session = useMemo(
        () =>
            query.data
                ? (allMobileSessions(
                      buildMobileSessionSections({
                          sessions: [query.data.session],
                          total: 1,
                          truncated: false,
                      }),
                  )[0] ?? null)
                : null,
        [query.data],
    );
    return {
        error: query.isError ? 'Unable to open this Session.' : null,
        isLoading: query.isPending || query.isFetching,
        /**
         * A disabled query stays pending forever; while the phone is offline that would read as an endless "Opening".
         */
        isOffline: shouldFetch && query.isPending && query.fetchStatus === 'idle',
        refresh: query.refetch,
        session,
    };
};
