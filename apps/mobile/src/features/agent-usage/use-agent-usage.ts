import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { AGENT_USAGE_POLL_MS } from './agent-usage-model';

/**
 * The Agent usage screen's reading, polled every {@link AGENT_USAGE_POLL_MS} while the app is in the foreground and
 * connected, and never in the background.
 */
export const useAgentUsage = () => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const isObservable = connectionScopeKey !== null && isForeground && status === 'connected';
    return useQuery({
        enabled: isObservable,
        gcTime: 5 * 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.agentUsage.read', {}),
        queryKey: ['mobile', 'agentUsage', connectionScopeKey],
        refetchInterval: isObservable ? AGENT_USAGE_POLL_MS : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 10_000,
    });
};
