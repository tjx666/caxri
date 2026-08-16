import type parcelWatcher from '@parcel/watcher';
import { describe, expect, it, vi } from 'vitest';

import type { StructuredLogger } from '../../../shared/node/logger';
import { GitMetadataWatcher } from '../metadata-watcher';

function createWatcher(subscribe: typeof parcelWatcher.subscribe) {
    const write = vi.fn();
    const watcher = new GitMetadataWatcher({
        logger: { write } as unknown as StructuredLogger,
        onStatusChanged: vi.fn(),
        onTopologyChanged: vi.fn(),
        subscribe,
    });
    return { watcher, write };
}

describe('GitMetadataWatcher close/subscribe race', () => {
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
