import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../../connection/mobile-client-provider';

export const useArchivedSessions = () => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    return useQuery({
        enabled: connectionScopeKey !== null && isForeground && status === 'connected',
        gcTime: 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.session.archived', {}),
        queryKey: ['mobile', 'archived-sessions', connectionScopeKey ?? 'unpaired'],
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
    });
};
