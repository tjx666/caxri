import { useCallback, useEffect, useState } from 'react';

import type { MobileDashboardResult } from '@caxri/protocol';

import { useReadCache } from '../../read-cache/read-cache-context';
import type { ReadCacheEntry } from '../../read-cache/read-cache-model';
import { cachedDashboardSchema } from '../../read-cache/read-cache-model';
import type { MobileDashboardSnapshot } from '../session-refresh';
import { projectMobileDashboard } from '../session-refresh';

interface SavedDashboard {
    entry: ReadCacheEntry<MobileDashboardResult>;
    scope: string;
}

/**
 * What the list shows: the live read once it answered, otherwise the copy this pairing saved, with its age.
 */
export const showDashboard = (
    saved: SavedDashboard | null,
    connectionScopeKey: string | null,
    live: MobileDashboardSnapshot | undefined,
): { savedAt: number | null; snapshot: MobileDashboardSnapshot | undefined } =>
    live !== undefined || saved === null || saved.scope !== connectionScopeKey
        ? { savedAt: null, snapshot: live }
        : { savedAt: saved.entry.savedAt, snapshot: projectMobileDashboard(saved.entry.value) };

/**
 * The Session dashboard this pairing last read, and the writer that keeps it current after each live read.
 */
export const useSavedDashboard = (connectionScopeKey: string | null) => {
    const readCache = useReadCache();
    const [saved, setSaved] = useState<SavedDashboard | null>(null);
    useEffect(() => {
        if (connectionScopeKey === null) return;
        let isActive = true;
        // eslint-disable-next-line no-void -- A missing or unreadable copy simply leaves the list waiting for the Server.
        void readCache
            .load(connectionScopeKey, { kind: 'dashboard' }, cachedDashboardSchema)
            .then((entry) => {
                if (isActive && entry) setSaved({ entry, scope: connectionScopeKey });
            });
        return () => {
            isActive = false;
        };
    }, [connectionScopeKey, readCache]);
    const save = useCallback(
        (dashboard: MobileDashboardResult): void => {
            if (connectionScopeKey !== null)
                readCache.save(connectionScopeKey, { kind: 'dashboard' }, dashboard);
        },
        [connectionScopeKey, readCache],
    );
    return { save, saved };
};
