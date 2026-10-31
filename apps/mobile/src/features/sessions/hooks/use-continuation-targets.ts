import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../../connection/mobile-client-provider';

/**
 * The providers Continue in Another Agent lists for a Chat, read each time the list opens: availability follows the
 * computer's installed Agents and usage guard, so a cached answer would offer a provider that has since run out.
 */
export const useContinuationTargets = (terminalId: string | undefined) => {
    const { connectionScopeKey, request, status } = useMobileClient();
    return useQuery({
        enabled: terminalId !== undefined && connectionScopeKey !== null && status === 'connected',
        gcTime: 0,
        networkMode: 'always',
        queryFn: () =>
            request('mobile.agentChat.continuationTargets', { terminalId: terminalId ?? '' }),
        queryKey: [
            'mobile',
            'continuation-targets',
            connectionScopeKey ?? 'unpaired',
            terminalId ?? '',
        ],
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
};
