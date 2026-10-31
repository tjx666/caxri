import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../../connection/mobile-client-provider';

/**
 * What the Session menu's Agent group reads while it is open (`mobile.session.menuState`): whether Caxri Bot manages
 * the Session and which conversations it can bring back. Read on every opening, as Desktop's Session row menu reads
 * them, since both change without a dashboard update. Only a control device reads it, as only it gets the entries.
 */
export const useSessionMenuState = (sessionId: string | undefined, isOpen: boolean) => {
    const { connectionScopeKey, request, status } = useMobileClient();
    return useQuery({
        enabled:
            isOpen &&
            sessionId !== undefined &&
            connectionScopeKey !== null &&
            status === 'connected',
        gcTime: 0,
        networkMode: 'always',
        queryFn: () => request('mobile.session.menuState', { sessionId: sessionId ?? '' }),
        queryKey: [
            'mobile',
            'session-menu-state',
            connectionScopeKey ?? 'unpaired',
            sessionId ?? '',
        ],
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
};
