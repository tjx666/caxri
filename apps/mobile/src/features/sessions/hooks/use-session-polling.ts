import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MobileConnectionStatus } from '../../connection/connection-state';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileSessionItem, MobileSessionSections } from '../session-model';
import { loadMobileSessionSections } from '../session-refresh';

const POLL_INTERVAL_MS = 2_500;
export const shouldPollSessionDashboard = (
    status: MobileConnectionStatus,
    isForeground: boolean,
): boolean => status === 'connected' && isForeground;

export const startSessionDashboardPolling = (poll: () => void): (() => void) => {
    poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
};

const emptySections: MobileSessionSections = {
    needsAttention: [],
    running: [],
    recent: [],
    total: 0,
    truncated: false,
};

export type SessionListEntry =
    | { id: string; label: string; type: 'header' }
    | { id: string; session: MobileSessionItem; type: 'session' };

export const allMobileSessions = (sections: MobileSessionSections): MobileSessionItem[] => [
    ...sections.needsAttention,
    ...sections.running,
    ...sections.recent,
];

export const flattenMobileSessionSections = (
    sections: MobileSessionSections,
): SessionListEntry[] => {
    const result: SessionListEntry[] = [];
    const append = (label: string, sessions: MobileSessionItem[]): void => {
        if (sessions.length === 0) return;
        result.push(
            { id: `header:${label}`, label, type: 'header' },
            ...sessions.map((session) => ({ id: session.id, session, type: 'session' as const })),
        );
    };
    append('NEEDS ATTENTION', sections.needsAttention);
    append('RUNNING', sections.running);
    append('RECENT', sections.recent);
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

export const useSessionPolling = () => {
    const { isForeground, request, status } = useMobileClient();
    const [sections, setSections] = useState<MobileSessionSections>(emptySections);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [hasLoaded, setHasLoaded] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const loading = useRef(false);
    const refreshEpoch = useRef(0);
    const pendingSections = useRef<MobileSessionSections | null>(null);
    const touchingList = useRef(false);

    const commitSections = useCallback((next: MobileSessionSections): void => {
        setSections(next);
        setSelectedId((current) => nextSelectedSessionId(current, next));
    }, []);

    const refresh = useCallback(async (): Promise<void> => {
        if (!shouldPollSessionDashboard(status, isForeground) || loading.current) return;
        const epoch = ++refreshEpoch.current;
        loading.current = true;
        setIsLoading(true);
        try {
            const result = await loadMobileSessionSections({
                dashboard: () => request('mobile.dashboard'),
            });
            if (epoch !== refreshEpoch.current) return;
            if (result.status === 'error') {
                setError('Unable to load Sessions.');
                return;
            }
            setError(null);
            setHasLoaded(true);
            if (touchingList.current) pendingSections.current = result.sections;
            else commitSections(result.sections);
        } finally {
            if (epoch === refreshEpoch.current) {
                loading.current = false;
                setIsLoading(false);
            }
        }
    }, [commitSections, isForeground, request, status]);

    useEffect(() => {
        if (!shouldPollSessionDashboard(status, isForeground)) {
            refreshEpoch.current += 1;
            loading.current = false;
            return;
        }
        const stop = startSessionDashboardPolling(() => {
            // eslint-disable-next-line no-void -- The polling lifecycle is owned by this effect.
            void refresh();
        });
        return () => {
            stop();
            refreshEpoch.current += 1;
            loading.current = false;
        };
    }, [isForeground, refresh, status]);

    const finishListInteraction = (): void => {
        touchingList.current = false;
        const pending = pendingSections.current;
        pendingSections.current = null;
        if (pending) commitSections(pending);
    };

    const sessions = useMemo(() => allMobileSessions(sections), [sections]);
    return {
        beginListInteraction: (): void => {
            touchingList.current = true;
        },
        entries: useMemo(() => flattenMobileSessionSections(sections), [sections]),
        error,
        finishListInteraction,
        hasLoaded,
        isLoading: shouldPollSessionDashboard(status, isForeground) && isLoading,
        refresh,
        sections,
        selected: sessions.find((session) => session.id === selectedId) ?? null,
        selectedId,
        selectSession: setSelectedId,
    };
};
