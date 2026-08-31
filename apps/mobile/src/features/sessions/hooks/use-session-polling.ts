import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useMobileClient } from '../../connection/mobile-client-provider';
import type { MobileSessionItem, MobileSessionSections } from '../session-model';
import { loadMobileSessionSections } from '../session-refresh';

const POLL_INTERVAL_MS = 2_500;
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
    const { request, status } = useMobileClient();
    const [sections, setSections] = useState<MobileSessionSections>(emptySections);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const loading = useRef(false);
    const pendingSections = useRef<MobileSessionSections | null>(null);
    const touchingList = useRef(false);

    const commitSections = useCallback((next: MobileSessionSections): void => {
        setSections(next);
        setSelectedId((current) => nextSelectedSessionId(current, next));
    }, []);

    const refresh = useCallback(async (): Promise<void> => {
        if (status !== 'connected' || loading.current) return;
        loading.current = true;
        try {
            const next = await loadMobileSessionSections({
                dashboard: () => request('mobile.dashboard'),
            });
            if (!next) return;
            if (touchingList.current) pendingSections.current = next;
            else commitSections(next);
        } finally {
            loading.current = false;
        }
    }, [commitSections, request, status]);

    useEffect(() => {
        if (status !== 'connected') return;
        const poll = (): void => {
            // eslint-disable-next-line no-void -- The polling lifecycle is owned by this effect.
            void refresh();
        };
        poll();
        const interval = setInterval(poll, POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [refresh, status]);

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
        finishListInteraction,
        refresh,
        sections,
        selected: sessions.find((session) => session.id === selectedId) ?? null,
        selectedId,
        selectSession: setSelectedId,
    };
};
