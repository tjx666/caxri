import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { isSessionListedOnMobileHome } from '@caxri/protocol';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';

import type { Translate } from '../../../i18n';
import { translate, useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type {
    DashboardSubscriptionMode,
    DashboardWants,
    MobileDashboardSnapshot,
} from '../dashboard';
import {
    dashboardPairingQueryKey,
    dashboardPollInterval,
    dashboardQueryKey,
    dashboardScopeKey,
    fetchMobileSessionDashboard,
    readDashboardPages,
    readDashboardSnapshot,
    shouldObserveDashboard,
    startDashboardSubscription,
} from '../dashboard';
import type {
    MobileSessionItem,
    MobileSessionListGroup,
    MobileSessionSections,
} from '../session-model';
import {
    emptyMobileGroupTotals,
    emptyMobileSessionGroups,
    MOBILE_SESSION_LIST_GROUPS,
} from '../session-model';
import { showDashboard, useSavedDashboard } from './use-saved-dashboard';

const emptySections: MobileSessionSections = {
    groups: emptyMobileSessionGroups(),
    groupTotals: emptyMobileGroupTotals(),
    sessions: [],
    total: 0,
};

/**
 * A row's `id` carries its group because a pinned Session can be listed twice (under Pinned and its status group), and
 * the list needs a distinct key for each copy.
 */
export type SessionListEntry =
    | { id: string; group: MobileSessionListGroup; label: string; type: 'header' }
    | { id: string; group: MobileSessionListGroup; session: MobileSessionItem; type: 'session' };

export const allMobileSessions = (sections: MobileSessionSections): MobileSessionItem[] =>
    sections.sessions;

const GROUP_LABEL_KEYS = {
    pinned: 'sessions.list.pinned',
    attention: 'sessions.list.attention',
    working: 'sessions.list.working',
    idle: 'sessions.list.idle',
} as const satisfies Record<MobileSessionListGroup, string>;

export const flattenMobileSessionSections = (
    sections: MobileSessionSections,
    t: Translate = translate,
): SessionListEntry[] => {
    const result: SessionListEntry[] = [];
    const listedSessionIds = new Set(sections.sessions.map(({ id }) => id));
    for (const group of MOBILE_SESSION_LIST_GROUPS) {
        const sessions = sections.groups[group].filter((session) =>
            isSessionListedOnMobileHome(session, listedSessionIds),
        );
        if (sessions.length === 0) continue;
        // The header id is the group, so it stays stable across languages; only the label is translated.
        result.push(
            { id: `header:${group}`, group, label: t(GROUP_LABEL_KEYS[group]), type: 'header' },
            ...sessions.map((session) => ({
                id: `${group}:${session.id}`,
                group,
                session,
                type: 'session' as const,
            })),
        );
    }
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

/**
 * What the Session home asks the Server for: the Project filter (`null` for All) and how many rows each group wants.
 */
export interface SessionPollingScope {
    projectId: string | null;
    wants: DashboardWants;
}

const allProjectsScope: SessionPollingScope = { projectId: null, wants: {} };

/**
 * The Project filter a read asks for. A filter for a Project the device can no longer see falls back to All, as the
 * chips do, instead of asking for a Project that answers no rows. Kept out of the hook to keep its control flow flat
 * (react-doctor/no-high-complexity-react-function).
 */
const readableProjectId = (
    projectId: string | null,
    listedProjectIds: readonly string[] | null,
): string | null =>
    projectId !== null && (listedProjectIds === null || listedProjectIds.includes(projectId))
        ? projectId
        : null;

const currentSubscriptionMode = ({
    identity,
    isObservable,
    state,
    subscriptionAvailable,
}: {
    identity: string;
    isObservable: boolean;
    state: { identity: string; mode: DashboardSubscriptionMode };
    subscriptionAvailable: boolean;
}): DashboardSubscriptionMode => {
    if (!isObservable) return 'pending';
    if (!subscriptionAvailable) return 'fallback';
    return state.identity === identity ? state.mode : 'pending';
};

export const useSessionPolling = (
    isVisible = true,
    scope: SessionPollingScope = allProjectsScope,
) => {
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
    /**
     * Projects the last read listed, which bound the Project filter a read may ask for.
     */
    const [listedProjectIds, setListedProjectIds] = useState<readonly string[] | null>(null);
    const projectId = readableProjectId(scope.projectId, listedProjectIds);
    const scopeKey = dashboardScopeKey({
        ...(projectId !== null && { projectId }),
        wants: scope.wants,
    });
    /**
     * Every scope's query for this pairing. A push or refresh invalidates them by this prefix, so changing the filter
     * or revealing more neither resubscribes nor misses a push; only the scope on screen is mounted to refetch.
     */
    const pairingQueryKey = useMemo(
        () => dashboardPairingQueryKey(connectionScopeKey ?? 'unpaired'),
        [connectionScopeKey],
    );
    const queryKey = useMemo(
        () => dashboardQueryKey(connectionScopeKey ?? 'unpaired', scopeKey),
        [connectionScopeKey, scopeKey],
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
    const mode = currentSubscriptionMode({
        identity: subscriptionIdentity,
        isObservable,
        state: subscriptionState,
        subscriptionAvailable,
    });
    const eventVersion = useRef(0);
    const invalidationTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const resubscribeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [frozenSections, setFrozenSections] = useState<MobileSessionSections | null>(null);
    const [requestedSelectedId, setRequestedSelectedId] = useState<string | null>(null);

    const scheduleInvalidation = useCallback((): void => {
        if (invalidationTimer.current !== null) clearTimeout(invalidationTimer.current);
        invalidationTimer.current = setTimeout(() => {
            invalidationTimer.current = null;
            void queryClient.invalidateQueries({ queryKey: pairingQueryKey });
        }, 0);
    }, [pairingQueryKey, queryClient]);

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
            void queryClient.cancelQueries({ queryKey: pairingQueryKey });
        };
    }, [
        isObservable,
        pairingQueryKey,
        queryClient,
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
                    fetchMobileSessionDashboard(
                        {
                            dashboard: async () => {
                                const { first, merged } = await readDashboardPages(
                                    (parameters) => request('mobile.dashboard', parameters),
                                    {
                                        ...(projectId !== null && { projectId }),
                                        wants: scope.wants,
                                    },
                                );
                                const ids = first.projects.map(({ id }) => id);
                                setListedProjectIds((current) =>
                                    current?.join('\n') === ids.join('\n') ? current : ids,
                                );
                                // The saved copy is the unfiltered first read: one frame-sized reply that every Project
                                // filter can narrow offline.
                                if (projectId === null) saveDashboard(first);
                                return merged;
                            },
                        },
                        projectId,
                    ),
                () => eventVersion.current,
                scheduleInvalidation,
            ),
        queryKey,
        // A new filter or reveal starts another query; the list keeps the previous rows until it answers, filtered on
        // the phone, instead of flashing empty.
        placeholderData: keepPreviousData,
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
        await queryClient.invalidateQueries({ queryKey: pairingQueryKey });
    }, [isObservable, mode, pairingQueryKey, queryClient]);

    /**
     * Shows a computer name the phone just set at once. `refresh` does nothing while the Session list is hidden, as it
     * is behind Settings, so the rename reply updates the last read instead of waiting for the next one.
     */
    const showHostDisplayName = useCallback(
        (hostDisplayName: string): void => {
            queryClient.setQueryData<MobileDashboardSnapshot>(queryKey, (current) =>
                current ? { ...current, hostDisplayName } : current,
            );
        },
        [queryClient, queryKey],
    );

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
         * The Project filter the shown rows were read for (`null` for All). Until a read for a newly chosen filter
         * answers, the list shows the previous rows, and their group totals describe that read, not the new filter.
         */
        readProjectId: snapshot?.projectId ?? null,
        /**
         * When the list shows a saved copy instead of a live read; `null` once the Server answered.
         */
        savedAt,
        refresh,
        sections,
        selected: sessions.find((session) => session.id === selectedId) ?? null,
        selectedId,
        selectSession: setRequestedSelectedId,
        showHostDisplayName,
    };
};
