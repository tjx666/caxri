import type { StructuredLogger } from '@caxri/system';
import type parcelWatcher from '@parcel/watcher';
import { describe, expect, it, vi } from 'vitest';

import { GitMetadataWatcher } from '../metadata-watcher';

function createWatcher(subscribe: typeof parcelWatcher.subscribe) {
    const recordMetric = vi.fn<StructuredLogger['recordMetric']>();
    const write = vi.fn<StructuredLogger['write']>();
    const onStatusChanged = vi.fn();
    const watcher = new GitMetadataWatcher({
        logger: { recordMetric, write } as unknown as StructuredLogger,
        onStatusChanged,
        onTopologyChanged: vi.fn(),
        subscribe,
    });
    return { watcher, write, onStatusChanged };
}

describe('GitMetadataWatcher close/subscribe race', () => {
    it('attributes primary metadata to the primary checkout and shared refs to all registered roots', async () => {
        let callback: parcelWatcher.SubscribeCallback | undefined;
        const subscribe: typeof parcelWatcher.subscribe = (_root, listener) => {
            callback = listener;
            return Promise.resolve({ unsubscribe: () => Promise.resolve() });
        };
        const { watcher, onStatusChanged } = createWatcher(subscribe);
        try {
            await watcher.watch('/repo/.git', '/repo', ['/repo', '/linked']);
            callback?.(null, [{ type: 'update', path: '/repo/.git/index' }]);
            await vi.waitFor(() =>
                expect(onStatusChanged).toHaveBeenCalledWith('/repo/.git', ['/repo']),
            );
            onStatusChanged.mockClear();
            callback?.(null, [{ type: 'update', path: '/repo/.git/refs/heads/main' }]);
            expect(onStatusChanged).toHaveBeenCalledWith('/repo/.git', ['/repo', '/linked']);
            await watcher.watch('/repo/.git', '/repo', ['/repo', '/replacement']);
            onStatusChanged.mockClear();
            callback?.(null, [{ type: 'update', path: '/repo/.git/packed-refs' }]);
            expect(onStatusChanged).toHaveBeenCalledWith('/repo/.git', ['/repo', '/replacement']);
        } finally {
            await watcher.close();
        }
    });

    it('releases a subscription that resolves after close and stays silent', async () => {
        const unsubscribe = vi.fn(() => Promise.resolve());
        const { promise, resolve } = Promise.withResolvers<parcelWatcher.AsyncSubscription>();
        const subscribe = vi.fn(() => promise) as unknown as typeof parcelWatcher.subscribe;
        const { watcher, write } = createWatcher(subscribe);

        const watching = watcher.watch('/repo/.git', '/repo', ['/repo']);
        await watcher.close();
        resolve({ unsubscribe });
        await watching;

        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(write).not.toHaveBeenCalledWith(
            'debug',
            'git.metadata_watcher_ready',
            expect.anything(),
        );
    });

    it('releases a subscription that resolves after its group was unwatched', async () => {
        const unsubscribe = vi.fn(() => Promise.resolve());
        const { promise, resolve } = Promise.withResolvers<parcelWatcher.AsyncSubscription>();
        const subscribe = vi.fn(() => promise) as unknown as typeof parcelWatcher.subscribe;
        const { watcher, write } = createWatcher(subscribe);

        const watching = watcher.watch('/repo/.git', '/repo', ['/repo']);
        await watcher.unwatch('/repo/.git');
        resolve({ unsubscribe });
        await watching;

        expect(unsubscribe).toHaveBeenCalledOnce();
        expect(write).not.toHaveBeenCalledWith(
            'debug',
            'git.metadata_watcher_ready',
            expect.anything(),
        );
    });

    it('keeps a subscription that resolves while the group is still live', async () => {
        const unsubscribe = vi.fn(() => Promise.resolve());
        const subscribe = vi.fn(() =>
            Promise.resolve({ unsubscribe }),
        ) as unknown as typeof parcelWatcher.subscribe;
        const { watcher, write } = createWatcher(subscribe);

        await watcher.watch('/repo/.git', '/repo', ['/repo']);

        expect(unsubscribe).not.toHaveBeenCalled();
        expect(write).toHaveBeenCalledWith('debug', 'git.metadata_watcher_ready', {
            fields: { repositories: 1, worktreeRoots: 1 },
        });

        await watcher.close();
        expect(unsubscribe).toHaveBeenCalledOnce();
    });
});
