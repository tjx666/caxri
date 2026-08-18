import { describe, expect, it } from 'vitest';

import { ExternalSyncDeferral } from '../external-sync-deferral';

describe('ExternalSyncDeferral', () => {
    it('coalesces same-Project refreshes until the final managed operation settles', () => {
        const deferral = new ExternalSyncDeferral();
        const pending = [
            { projectId: 'project-a' },
            { projectId: 'project-a' },
            { projectId: 'project-b' },
        ];

        expect(deferral.deferIfPending('project-a', pending)).toBe(true);
        expect(deferral.deferIfPending('project-a', pending)).toBe(true);
        expect(deferral.deferIfPending('project-c', pending)).toBe(false);
        expect(deferral.flushReady([{ projectId: 'project-a' }])).toEqual([]);
        expect(deferral.flushReady([])).toEqual(['project-a']);
        expect(deferral.flushReady([])).toEqual([]);
    });
});
