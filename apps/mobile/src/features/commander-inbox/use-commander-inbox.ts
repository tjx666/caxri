import { useCallback, useEffect, useMemo, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useMobileClient } from '../connection/mobile-client-provider';
import { commanderInboxReplyErrorMessage } from './commander-inbox-model';

const commanderInboxQueryKey = (scope: string) => ['mobile', 'commander-inbox', scope] as const;

/**
 * The open Commander Inbox items, kept live by the `commanderInbox` subscription. Polls only while no subscription is
 * active (for example right after a resync), the same fallback the Changes view uses.
 */
export const useCommanderInbox = () => {
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
    const queryKey = useMemo(() => commanderInboxQueryKey(scope), [scope]);
    const isObservable = connectionScopeKey !== null && isForeground && status === 'connected';
    const identity = `${scope}:${connectionEpoch}`;
    const [subscription, setSubscription] = useState({ identity: '', active: false });
    const hasSubscription = subscription.identity === identity && subscription.active;
    const query = useQuery({
        enabled: isObservable,
        gcTime: 5 * 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.commanderInbox.list', {}),
        queryKey,
        refetchInterval: isObservable && !hasSubscription ? 5_000 : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });
    useEffect(() => {
        if (!isObservable || !subscriptionAvailable) return;
        let isDisposed = false;
        let isResyncRequired = false;
        let handle: Awaited<ReturnType<typeof subscribe>> | null = null;
        const invalidate = () => {
            // eslint-disable-next-line no-void -- The query observer owns the resulting read and error state.
            void queryClient.invalidateQueries({ queryKey, exact: true });
        };
        const attach = async (): Promise<void> => {
            try {
                const acquired = await subscribe({ kind: 'commanderInbox' }, (message) => {
                    if (
                        isDisposed ||
                        (message.kind !== 'commanderInbox.changed' &&
                            message.kind !== 'resync-required')
                    )
                        return;
                    invalidate();
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
                invalidate();
            } catch {
                if (!isDisposed) setSubscription({ identity, active: false });
            }
        };
        // eslint-disable-next-line no-void -- Cleanup releases the subscription.
        void attach();
        return () => {
            isDisposed = true;
            setSubscription({ identity, active: false });
            // eslint-disable-next-line no-void -- The connection may already have closed.
            if (handle) void handle.unsubscribe();
        };
    }, [identity, isObservable, queryClient, queryKey, subscribe, subscriptionAvailable]);
    const { refetch } = query;
    const refresh = useCallback(() => {
        // eslint-disable-next-line no-void -- The query observer owns refresh errors.
        if (isObservable) void refetch();
    }, [isObservable, refetch]);
    return { isObservable, query, refresh };
};

/**
 * Sends one reply at a time. The caller keeps its draft until `send` resolves true, so a failed reply loses nothing.
 */
export const useCommanderInboxReply = (onSent: () => void) => {
    const { request } = useMobileClient();
    const [pendingId, setPendingId] = useState<string | null>(null);
    const [error, setError] = useState<{ itemId: string; message: string } | null>(null);
    const send = useCallback(
        async (itemId: string, body: string): Promise<boolean> => {
            setPendingId(itemId);
            setError(null);
            try {
                await request('mobile.commanderInbox.reply', { id: itemId, body });
                onSent();
                return true;
            } catch (error_) {
                setError({ itemId, message: commanderInboxReplyErrorMessage(error_) });
                return false;
            } finally {
                setPendingId(null);
            }
        },
        [onSent, request],
    );
    return { error, pendingId, send };
};
