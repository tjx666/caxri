import { useCallback, useEffect, useRef } from 'react';

import type { AgentUsageReadout, UsageLimit, UsageNotice } from '@caxri/protocol';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { AGENT_CHAT_PLAN_LIMITS_POLL_MS } from './agent-chat-plan-limits';

const usageKey = (connectionScopeKey: string | null, terminalId: string) =>
    ['mobile', 'agentChatUsage', connectionScopeKey, terminalId] as const;

/**
 * The conversation's tokens, estimated cost, and the provider's plan limits (`mobile.agentChat.readUsage`), read while
 * the app is in the foreground and connected and re-read every {@link AGENT_CHAT_PLAN_LIMITS_POLL_MS}. The pace
 * reminder, the usage chip, and the Session usage sheet with its Plan limits share this one read. A failed read shows
 * nothing rather than an error: every one of them is a side note to the conversation. Passing the snapshot's
 * `lastResponseAt` re-reads as soon as a response finishes, so the tokens and cost keep pace with the context figure
 * instead of trailing it until the next poll.
 */
export const useAgentChatUsage = (
    terminalId: string,
    lastResponseAt?: number,
): AgentUsageReadout | undefined => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const queryClient = useQueryClient();
    const isObservable = connectionScopeKey !== null && isForeground && status === 'connected';
    const seenResponseAt = useRef(lastResponseAt);
    useEffect(() => {
        if (lastResponseAt === seenResponseAt.current) return;
        seenResponseAt.current = lastResponseAt;
        void queryClient.invalidateQueries({ queryKey: usageKey(connectionScopeKey, terminalId) });
    }, [connectionScopeKey, lastResponseAt, queryClient, terminalId]);
    const query = useQuery({
        enabled: isObservable,
        gcTime: 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.agentChat.readUsage', { terminalId }),
        queryKey: usageKey(connectionScopeKey, terminalId),
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
 * The provider's plan limits for the pace reminder and the Session usage sheet; see {@link useAgentChatUsage}.
 */
export const useAgentChatPlanLimits = (terminalId: string) => useAgentChatUsage(terminalId)?.limit;

/**
 * Where each notice's dismissal lands on the cached limit, as Desktop's `usage-notice-client`.
 */
const DISMISSED_AT = {
    credits: 'creditsNoticeDismissedAt',
    planPace: 'paceDismissedAt',
} as const satisfies Record<UsageNotice, keyof UsageLimit>;

/**
 * A plan notice's close button (the pace reminder, or the credits notice): the Server keeps the dismissal for the
 * Chat's provider (`mobile.agentChat.dismissUsageNotice`), so the notice stays hidden after the OS kills and relaunches
 * the app, and on Desktop too. The cached limit takes the dismissal at once, so the row disappears before the next
 * read; a failed request leaves the next read to bring the notice back.
 */
export const useDismissAgentChatUsageNotice = (terminalId: string, notice: UsageNotice) => {
    const { connectionScopeKey, request } = useMobileClient();
    const queryClient = useQueryClient();
    return useCallback(async (): Promise<void> => {
        const queryKey = usageKey(connectionScopeKey, terminalId);
        // A read already in flight would otherwise land a pre-dismissal limit and bring the notice back.
        await queryClient.cancelQueries({ queryKey });
        queryClient.setQueryData<AgentUsageReadout | null>(queryKey, (readout) =>
            readout?.limit
                ? {
                      ...readout,
                      limit: { ...readout.limit, [DISMISSED_AT[notice]]: Date.now() },
                  }
                : readout,
        );
        try {
            await request('mobile.agentChat.dismissUsageNotice', { terminalId, notice });
        } catch {
            // The next read takes the Server's answer and shows the notice again.
        }
    }, [connectionScopeKey, notice, queryClient, request, terminalId]);
};
