import { describe, expect, it, vi } from 'vitest';

import { ArtifactRefreshCoordinator } from '../watch-coordinator';

describe('ArtifactRefreshCoordinator', () => {
    it('processes a rebuild requested while publishing initial readiness', async () => {
        const readiness = Promise.withResolvers<void>();
        const reportReady = vi.fn(() => readiness.promise);
        const refreshArtifact = vi.fn(() => Promise.resolve());
        const coordinator = new ArtifactRefreshCoordinator({
            refreshArtifact,
            reportReady,
            watcher: { close: () => Promise.resolve() },
        });

        const initialRefresh = coordinator.refresh();
        await vi.waitFor(() => expect(reportReady).toHaveBeenCalledOnce());
        await coordinator.refresh();
        readiness.resolve();
        await initialRefresh;

        expect(refreshArtifact).toHaveBeenCalledTimes(2);
        expect(reportReady).toHaveBeenCalledOnce();
    });
});
