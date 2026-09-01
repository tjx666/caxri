import { describe, expect, it, vi } from 'vitest';

import { loadMobileSessionSections } from '../session-refresh';

describe('loadMobileSessionSections', () => {
    it('reports a polling failure without manufacturing an empty dashboard', async () => {
        const unavailable = vi.fn(() => Promise.reject(new Error('offline')));

        await expect(
            loadMobileSessionSections({
                dashboard: unavailable,
            }),
        ).resolves.toEqual({ status: 'error' });
        expect(unavailable).toHaveBeenCalledOnce();
    });

    it('reports a successful empty dashboard explicitly', async () => {
        await expect(
            loadMobileSessionSections({
                dashboard: () => Promise.resolve({ sessions: [], total: 0, truncated: false }),
            }),
        ).resolves.toEqual({
            sections: { needsAttention: [], recent: [], running: [], total: 0, truncated: false },
            status: 'success',
        });
    });
});
