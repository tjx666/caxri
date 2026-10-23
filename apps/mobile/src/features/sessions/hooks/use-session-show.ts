import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { DashboardSubscriptionMode } from '../dashboard-query';
import {
    readDashboardSnapshot,
    shouldObserveDashboard,
    startDashboardSubscription,
} from '../dashboard-query';
import { buildMobileSessionSections } from '../session-model';
import { sessionShowRefresh } from '../session-show-refresh';
import { allMobileSessions } from './use-session-polling';

export const useSessionShow = (sessionId: string | null, shouldFetch: boolean) => {
    const { t } = useTranslation();
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
    const queryKey = useMemo(
        () => ['mobile', 'session', connectionScopeKey ?? 'unpaired', sessionId],
        [connectionScopeKey, sessionId],
    );
    const isObservable =
        sessionId !== null &&
        shouldFetch &&
        shouldObserveDashboard({
            connectionScopeKey,
            isForeground,
            status,
            visible: true,
        });
    const subscriptionIdentity = `${connectionScopeKey ?? 'unpaired'}:${connectionEpoch}:${sessionId}`;
    const [subscriptionState, setSubscriptionState] = useState<{
        identity: string;
        mode: DashboardSubscriptionMode;
    }>({ identity: subscriptionIdentity, mode: 'pending' });
    const [subscriptionRetry, setSubscriptionRetry] = useState(0);
    const eventVersion = useRef(0);
    const invalidationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refresh = sessionShowRefresh({
        isObservable,
        subscriptionAvailable,
        subscriptionIdentity,
        subscriptionState,
    });

    const scheduleInvalidation = useCallback((): void => {
        if (invalidationTimer.current !== null) clearTimeout(invalidationTimer.current);
        invalidationTimer.current = setTimeout(() => {
            invalidationTimer.current = null;
            void queryClient.invalidateQueries({ queryKey, exact: true });
        }, 0);
    }, [queryClient, queryKey]);

    useEffect(() => {
        if (!isObservable || !subscriptionAvailable) return;
        let resubscribeTimer: ReturnType<typeof setTimeout> | undefined;
        const stop = startDashboardSubscription(
            (onEvent) => subscribe({ kind: 'dashboard' }, onEvent),
            () => {
                eventVersion.current += 1;
                scheduleInvalidation();
            },
            (nextMode) => setSubscriptionState({ identity: subscriptionIdentity, mode: nextMode }),
            () => {
                resubscribeTimer = setTimeout(() => {
                    setSubscriptionRetry((current) => current + 1);
                }, 2_500);
            },
        );
        return () => {
            stop();
            clearTimeout(resubscribeTimer);
            if (invalidationTimer.current !== null) clearTimeout(invalidationTimer.current);
            invalidationTimer.current = null;
            setSubscriptionState({ identity: subscriptionIdentity, mode: 'pending' });
        };
    }, [
        isObservable,
        queryClient,
        queryKey,
        scheduleInvalidation,
        subscribe,
        subscriptionAvailable,
        subscriptionIdentity,
        subscriptionRetry,
    ]);
    const query = useQuery({
        enabled: refresh.enabled,
        gcTime: 0,
        networkMode: 'always',
        queryFn: () =>
            readDashboardSnapshot(
                () => request('mobile.session.show', { sessionId: sessionId! }),
                () => eventVersion.current,
                scheduleInvalidation,
            ),
        queryKey,
        refetchInterval: refresh.pollInterval,
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
                      buildMobileSessionSections(
                          {
                              sessions: [query.data.session],
                              total: 1,
                              truncated: false,
                          },
                          t,
                      ),
                  )[0] ?? null)
                : null,
        [query.data, t],
    );
    return {
        error: query.isError ? t('sessions.show.openFailed') : null,
        isLoading: query.isPending || query.isFetching,
        /**
         * A disabled query stays pending forever; while the phone is offline that would read as an endless "Opening".
         */
        isOffline: shouldFetch && query.isPending && query.fetchStatus === 'idle',
        refresh: query.refetch,
        session,
    };
};
