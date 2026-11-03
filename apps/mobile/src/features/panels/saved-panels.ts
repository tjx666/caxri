import type { MethodResult } from '@caxri/protocol';
import { mobilePanelsMethods } from '@caxri/protocol';
import type { QueryClient } from '@tanstack/react-query';

import type { ReadCacheEntry } from '../read-cache/read-cache-model';

export type PanelsList = MethodResult<'mobile.panels.list'>;

export const cachedPanelsSchema = mobilePanelsMethods['mobile.panels.list'].result;

export const panelQueryKey = (connectionScopeKey: string | null, key: readonly unknown[]) => [
    'mobile',
    'panels',
    connectionScopeKey ?? 'unpaired',
    ...key,
];

/**
 * One key per pairing, not per Session: Server Core lists the Desktop's secondary-sidebar views from its Extension
 * catalog and reads the Session only to authorize the device, so every Session gets the same list. Keyed per Session,
 * each newly opened Session showed only its fixed tabs until its own read answered, then the view tabs pushed in.
 */
export const panelsListQueryKey = (connectionScopeKey: string | null) =>
    panelQueryKey(connectionScopeKey, ['list']);

/**
 * Puts the view list this pairing last saved into the query cache, so a Session opened before the live read answers (a
 * cold start, or while reconnecting) shows its view tabs from the first frame. A live read already in the cache wins.
 * The entry keeps its saved time, so the next enabled read still refreshes it.
 */
export const seedSavedPanels = (
    queryClient: Pick<QueryClient, 'getQueryData' | 'setQueryData'>,
    connectionScopeKey: string,
    saved: ReadCacheEntry<PanelsList>,
): void => {
    const queryKey = panelsListQueryKey(connectionScopeKey);
    if (queryClient.getQueryData(queryKey) !== undefined) return;
    queryClient.setQueryData(queryKey, saved.value, { updatedAt: saved.savedAt });
};
