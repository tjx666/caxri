import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useQuery, useQueryClient } from '@tanstack/react-query';

import type { Translate } from '../../../i18n';
import { translate, useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { DashboardSubscriptionMode } from '../dashboard-query';
import {
    dashboardPollInterval,
    dashboardQueryKey,
    readDashboardSnapshot,
    shouldObserveDashboard,
    startDashboardSubscription,
} from '../dashboard-query';
import type { MobileSessionItem, MobileSessionSections } from '../session-model';
import type { MobileDashboardSnapshot } from '../session-refresh';
import { fetchMobileSessionDashboard } from '../session-refresh';
import { showDashboard, useSavedDashboard } from './use-saved-dashboard';

const emptySections: MobileSessionSections = {
    needsAttention: [],
    running: [],
    recent: [],
    total: 0,
    truncated: false,
};

/**
 * The Session list's sections in order, which pick each heading's icon.
 */
export type SessionListGroup = 'attention' | 'recent' | 'running';

export type SessionListEntry =
    | { id: string; group: SessionListGroup; label: string; type: 'header' }
    | { id: string; session: MobileSessionItem; type: 'session' };

export const allMobileSessions = (sections: MobileSessionSections): MobileSessionItem[] => [
    ...sections.needsAttention,
    ...sections.running,
    ...sections.recent,
];

export const flattenMobileSessionSections = (
    sections: MobileSessionSections,
    t: Translate = translate,
): SessionListEntry[] => {
    const result: SessionListEntry[] = [];
    /**
     * `key` keeps the header ID stable across languages; only the label is translated.
     */
    const append = (
        key: string,
        group: SessionListGroup,
        label: string,
        sessions: MobileSessionItem[],
    ): void => {
        if (sessions.length === 0) return;
        result.push(
            { id: `header:${key}`, group, label, type: 'header' },
            ...sessions.map((session) => ({ id: session.id, session, type: 'session' as const })),
        );
    };
    append(
        'NEEDS ATTENTION',
        'attention',
        t('sessions.list.needsAttention'),
        sections.needsAttention,
    );
    append('RUNNING', 'running', t('sessions.list.running'), sections.running);
    append('RECENT', 'recent', t('sessions.list.recent'), sections.recent);
    return result;
};

export const nextSelectedSessionId = (
    current: string | null,
    sections: MobileSessionSections,
): string | null => {
    const available = allMobileSessions(sections);
    if (current !== null && available.some((session) => session.id === current)) return current;
    return null;
};

export const projectSessionList = (
    snapshot: MobileDashboardSnapshot | undefined,
    frozenSections: MobileSessionSections | null,
    requestedSelectedId: string | null,
): { hasLoaded: boolean; sections: MobileSessionSections; selectedId: string | null } => {
    const sections = frozenSections ?? snapshot?.sections ?? emptySections;
    return {
        hasLoaded: snapshot !== undefined,
        sections,
        selectedId: nextSelectedSessionId(requestedSelectedId, sections),
    };
};

export const useSessionPolling = (isVisible = true) => {
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
    const { t } = useTranslation();
    const { save: saveDashboard, saved } = useSavedDashboard(connectionScopeKey);
    const queryKey = useMemo(
        () => dashboardQueryKey(connectionScopeKey ?? 'unpaired'),
        [connectionScopeKey],
    );
    const isObservable = shouldObserveDashboard({
        connectionScopeKey,
        isForeground,
        status,
        visible: isVisible,
    });
    const subscriptionIdentity = `${connectionScopeKey ?? 'unpaired'}:${connectionEpoch}`;
    const [subscriptionState, setSubscriptionState] = useState<{
        identity: string;
        mode: DashboardSubscriptionMode;
    }>({ identity: subscriptionIdentity, mode: 'pending' });
    const [subscriptionRetry, setSubscriptionRetry] = useState(0);
    const mode: DashboardSubscriptionMode = !isObservable
        ? 'pending'
        : !subscriptionAvailable
          ? 'fallback'
          : subscriptionState.identity === subscriptionIdentity
            ? subscriptionState.mode
            : 'pending';
    const eventVersion = useRef(0);
    const invalidationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resubscribeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [frozenSections, setFrozenSections] = useState<MobileSessionSections | null>(null);
    const [requestedSelectedId, setRequestedSelectedId] = useState<string | null>(null);

    const scheduleInvalidation = useCallback((): void => {
        if (invalidationTimer.current !== null) clearTimeout(invalidationTimer.current);
        invalidationTimer.current = setTimeout(() => {
            invalidationTimer.current = null;
            // eslint-disable-next-line no-void -- The query observer owns the resulting read and error state.
            void queryClient.invalidateQueries({ queryKey, exact: true });
        }, 0);
    }, [queryClient, queryKey]);

    useEffect(() => {
        if (!isObservable || !subscriptionAvailable) return;
        const stop = startDashboardSubscription(
            (onEvent) => subscribe({ kind: 'dashboard' }, onEvent),
            () => {
                eventVersion.current += 1;
                scheduleInvalidation();
            },
            (nextMode) => setSubscriptionState({ identity: subscriptionIdentity, mode: nextMode }),
            () => {
                if (resubscribeTimer.current !== null) clearTimeout(resubscribeTimer.current);
                resubscribeTimer.current = setTimeout(() => {
                    resubscribeTimer.current = null;
                    setSubscriptionRetry((current) => current + 1);
                }, 2_500);
            },
        );
        return () => {
            stop();
            setSubscriptionState({ identity: subscriptionIdentity, mode: 'pending' });
            if (invalidationTimer.current !== null) clearTimeout(invalidationTimer.current);
            invalidationTimer.current = null;
            if (resubscribeTimer.current !== null) clearTimeout(resubscribeTimer.current);
            resubscribeTimer.current = null;
            // eslint-disable-next-line no-void -- Disabled queries retain the last authenticated snapshot.
            void queryClient.cancelQueries({ queryKey, exact: true });
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
        enabled: isObservable && mode !== 'pending',
        gcTime: 0,
        networkMode: 'always',
        queryFn: () =>
            readDashboardSnapshot(
                () =>
                    fetchMobileSessionDashboard({
                        dashboard: async () => {
                            const dashboard = await request('mobile.dashboard');
                            saveDashboard(dashboard);
                            return dashboard;
                        },
                    }),
                () => eventVersion.current,
                scheduleInvalidation,
            ),
        queryKey,
        refetchInterval: dashboardPollInterval(isObservable, mode),
        refetchIntervalInBackground: false,
        refetchOnReconnect: false,
        refetchOnWindowFocus: false,
        retry: false,
        staleTime: 0,
    });

    const { savedAt, snapshot } = useMemo(
        () => showDashboard(saved, connectionScopeKey, query.data),
        [connectionScopeKey, query.data, saved],
    );
    const { hasLoaded, sections, selectedId } = projectSessionList(
        snapshot,
        frozenSections,
        requestedSelectedId,
    );

    const refresh = useCallback(async (): Promise<void> => {
        if (!isObservable || mode === 'pending') return;
        await queryClient.invalidateQueries({ queryKey, exact: true });
    }, [isObservable, mode, queryClient, queryKey]);

    const finishListInteraction = (): void => {
        setFrozenSections(null);
    };

    const sessions = useMemo(() => allMobileSessions(sections), [sections]);
    return {
        beginListInteraction: (): void => {
            setFrozenSections((current) => current ?? sections);
        },
        deviceRole: snapshot?.deviceRole ?? null,
        entries: useMemo(() => flattenMobileSessionSections(sections, t), [sections, t]),
        error: query.isError ? t('sessions.list.loadFailed') : null,
        finishListInteraction,
        hasLoaded,
        hostDisplayName: snapshot?.hostDisplayName ?? 'Caxri',
        isLoading: isObservable && query.isFetching,
        projects: snapshot?.projects ?? [],
        /**
         * When the list shows a saved copy instead of a live read; `null` once the Server answered.
         */
        savedAt,
        refresh,
        sections,
        selected: sessions.find((session) => session.id === selectedId) ?? null,
        selectedId,
        selectSession: setRequestedSelectedId,
    };
};
