import { describe, expect, it, vi } from 'vitest';

import { buildMobileSessionSections } from '../session-model';
import { fetchMobileSessionDashboard } from '../session-refresh';

describe('fetchMobileSessionDashboard', () => {
    it('rejects a failed read so Query retains its last valid dashboard', async () => {
        const unavailable = vi.fn(() => Promise.reject(new Error('offline')));

        await expect(
            fetchMobileSessionDashboard({
                dashboard: unavailable,
            }),
        ).rejects.toThrow('offline');
        expect(unavailable).toHaveBeenCalledOnce();
    });

    it('keeps an authorized Project with no Sessions in the dashboard view', async () => {
        await expect(
            fetchMobileSessionDashboard({
                dashboard: () =>
                    Promise.resolve({
                        deviceRole: 'view',
                        hostDisplayName: 'Test computer',
                        projects: [{ id: 'project-one', displayTitle: 'Empty Project' }],
                        sessions: [],
                        total: 0,
                        truncated: false,
                    }),
            }),
        ).resolves.toEqual({
            deviceRole: 'view',
            hostDisplayName: 'Test computer',
            projects: [{ id: 'project-one', displayTitle: 'Empty Project' }],
            sections: buildMobileSessionSections({ sessions: [], total: 0, truncated: false }),
        });
    });
});
