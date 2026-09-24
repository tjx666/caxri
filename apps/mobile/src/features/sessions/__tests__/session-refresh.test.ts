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

    it('keeps an authorized Project with no Sessions in the dashboard view', async () => {
        await expect(
            loadMobileSessionSections({
                dashboard: () =>
                    Promise.resolve({
                        hostDisplayName: 'Test computer',
                        projects: [{ id: 'project-one', displayTitle: 'Empty Project' }],
                        sessions: [],
                        total: 0,
                        truncated: false,
                    }),
            }),
        ).resolves.toEqual({
            hostDisplayName: 'Test computer',
            projects: [{ id: 'project-one', displayTitle: 'Empty Project' }],
            sections: { needsAttention: [], recent: [], running: [], total: 0, truncated: false },
            status: 'success',
        });
    });
});
