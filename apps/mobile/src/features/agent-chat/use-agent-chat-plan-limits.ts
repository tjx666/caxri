import { useQuery } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { AGENT_CHAT_PLAN_LIMITS_POLL_MS } from './agent-chat-plan-limits';

/**
 * The provider's plan limits for the open model sheet, read while the app is in the foreground and connected and
 * re-read every {@link AGENT_CHAT_PLAN_LIMITS_POLL_MS}. A failed read shows nothing rather than an error: the limits are
 * a side note to choosing a model.
 */
export const useAgentChatPlanLimits = (terminalId: string) => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const isObservable = connectionScopeKey !== null && isForeground && status === 'connected';
    const query = useQuery({
        enabled: isObservable,
        gcTime: 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.agentChat.readUsage', { terminalId }),
        queryKey: ['mobile', 'agentChatPlanLimits', connectionScopeKey, terminalId],
        refetchInterval: isObservable ? AGENT_CHAT_PLAN_LIMITS_POLL_MS : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    return query.data ?? undefined;
};
