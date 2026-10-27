import { useCallback } from 'react';

import type { UsageLimit } from '@caxri/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { AGENT_CHAT_PLAN_LIMITS_POLL_MS } from './agent-chat-plan-limits';

const planLimitsKey = (connectionScopeKey: string | null, terminalId: string) =>
    ['mobile', 'agentChatPlanLimits', connectionScopeKey, terminalId] as const;

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
        queryKey: planLimitsKey(connectionScopeKey, terminalId),
        refetchInterval: isObservable ? AGENT_CHAT_PLAN_LIMITS_POLL_MS : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    return query.data ?? undefined;
};

/**
 * The pace reminder's close button: the Server keeps the dismissal for the Chat's provider
 * (`mobile.agentChat.dismissPlanPace`), so the reminder stays hidden for the rest of the day after the OS kills and
 * relaunches the app, and on Desktop too. The cached limit takes the dismissal at once, so the row disappears before
 * the next read; a failed request leaves the next read to bring the reminder back.
 */
export const useDismissAgentChatPlanPace = (terminalId: string) => {
    const { connectionScopeKey, request } = useMobileClient();
    const queryClient = useQueryClient();
    return useCallback(async (): Promise<void> => {
        const queryKey = planLimitsKey(connectionScopeKey, terminalId);
        // A read already in flight would otherwise land a pre-dismissal limit and bring the notice back.
        await queryClient.cancelQueries({ queryKey });
        queryClient.setQueryData<UsageLimit | null>(queryKey, (limit) =>
            limit ? { ...limit, paceDismissedAt: Date.now() } : limit,
        );
        try {
            await request('mobile.agentChat.dismissPlanPace', { terminalId });
        } catch {
            // The next read takes the Server's answer and shows the reminder again.
        }
    }, [connectionScopeKey, queryClient, request, terminalId]);
};
