import { useCallback, useEffect, useState } from 'react';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { useReadCache } from '../../read-cache/read-cache-context';
import type { RecentSessions } from '../recent-sessions';
import {
    mergeSavedRecentSessions,
    recentSessionsSchema,
    rememberRecentSession,
} from '../recent-sessions';

/**
 * The Sessions this phone opened for the current pairing, newest first, kept across a cold start so "Previous Session"
 * still knows where to go after the system ends a backgrounded app. Like saved drafts, nothing is saved until the
 * earlier copy was read, so an early visit never overwrites the list it has not restored yet.
 */
export const useRecentSessions = (): {
    recentSessionIds: RecentSessions;
    rememberSessionVisit: (sessionId: string) => void;
} => {
    const { connectionScopeKey } = useMobileClient();
    const readCache = useReadCache();
    const [recentSessionIds, setRecentSessionIds] = useState<RecentSessions>([]);
    const [restoredScope, setRestoredScope] = useState<string | null>(null);
    useEffect(() => {
        if (connectionScopeKey === null) return;
        let isActive = true;
        void readCache
            .load(connectionScopeKey, { kind: 'recentSessions' }, recentSessionsSchema)
            .then((entry) => {
                if (!isActive) return;
                if (entry)
                    setRecentSessionIds((current) =>
                        mergeSavedRecentSessions(current, entry.value),
                    );
                setRestoredScope(connectionScopeKey);
            });
        return () => {
            isActive = false;
        };
    }, [connectionScopeKey, readCache]);
    useEffect(() => {
        if (restoredScope === null || restoredScope !== connectionScopeKey) return;
        readCache.save(restoredScope, { kind: 'recentSessions' }, recentSessionIds);
    }, [connectionScopeKey, readCache, recentSessionIds, restoredScope]);
    const rememberSessionVisit = useCallback((sessionId: string): void => {
        setRecentSessionIds((current) => rememberRecentSession(current, sessionId));
    }, []);
    return { recentSessionIds, rememberSessionVisit };
};
