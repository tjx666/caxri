import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';

import { readCacheFileName } from '../../read-cache/read-cache-model';
import type { PanelsList } from '../saved-panels';
import { cachedPanelsSchema, panelsListQueryKey, seedSavedPanels } from '../saved-panels';

const savedList: PanelsList = {
    panels: [
        {
            id: 'caxri.files',
            title: 'Files',
            views: [{ id: 'caxri.files.tree', kind: 'files', title: 'Files' }],
        },
        {
            id: 'caxri.status',
            title: 'Status',
            views: [{ id: 'caxri.status.tree', kind: 'tree', title: 'Status' }],
        },
    ],
};

describe('saved Project views', () => {
    it('shares one view list across every Session of a pairing', () => {
        expect(panelsListQueryKey('scope-a')).toEqual(['mobile', 'panels', 'scope-a', 'list']);
        expect(readCacheFileName({ kind: 'panels' })).toBe('panels.json');
    });

    it('accepts the live list shape it saves', () => {
        expect(cachedPanelsSchema.parse(savedList)).toEqual(savedList);
    });

    it('seeds the saved list as stale data before the live read answers', () => {
        const queryClient = new QueryClient();
        seedSavedPanels(queryClient, 'scope-a', { savedAt: 1_000, value: savedList });
        const query = queryClient.getQueryCache().find({ queryKey: panelsListQueryKey('scope-a') });
        expect(query?.state.data).toEqual(savedList);
        expect(query?.state.dataUpdatedAt).toBe(1_000);
    });

    it('keeps a live read that already answered', () => {
        const queryClient = new QueryClient();
        const live: PanelsList = { panels: [] };
        queryClient.setQueryData(panelsListQueryKey('scope-a'), live);
        seedSavedPanels(queryClient, 'scope-a', { savedAt: 1_000, value: savedList });
        expect(queryClient.getQueryData(panelsListQueryKey('scope-a'))).toBe(live);
    });
});
