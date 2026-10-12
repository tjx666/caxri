import type { StructuredLogger } from '@caxri/system';
import type parcelWatcher from '@parcel/watcher';
import { describe, expect, it, vi } from 'vitest';

import { WatchHub } from '../../watch';
import type { GitMetadataWatcherOptions } from '../metadata-watcher';
import { GitMetadataWatcher } from '../metadata-watcher';

function createWatcher(
    subscribe: typeof parcelWatcher.subscribe,
    options: Partial<GitMetadataWatcherOptions> = {},
) {
    const recordMetric = vi.fn<StructuredLogger['recordMetric']>();
    const write = vi.fn<StructuredLogger['write']>();
    const onStatusChanged = vi.fn();
    const watcher = new GitMetadataWatcher({
        logger: { recordMetric, write } as unknown as StructuredLogger,
        onStatusChanged,
        onTopologyChanged: vi.fn(),
        subscribe,
        ...options,
    });
    return { watcher, write, onStatusChanged };
}

describe('GitMetadataWatcher close/subscribe race', () => {
    it('releases an old subscription when the same repository is registered again', async () => {
        const first = Promise.withResolvers<parcelWatcher.AsyncSubscription>();
        const oldUnsubscribe = vi.fn(() => Promise.resolve());
        const currentUnsubscribe = vi.fn(() => Promise.resolve());
        const subscribe = vi
            .fn<typeof parcelWatcher.subscribe>()
            .mockReturnValueOnce(first.promise)
            .mockResolvedValueOnce({ unsubscribe: currentUnsubscribe });
        const hub = new WatchHub({ subscribe });
        const { watcher } = createWatcher(subscribe, { watchHub: hub });
        const oldWatch = watcher.watch('/repo/.git', '/repo', ['/repo']);
        await watcher.unwatch('/repo/.git');
        await watcher.watch('/repo/.git', '/repo', ['/repo']);
        first.resolve({ unsubscribe: oldUnsubscribe });
        await oldWatch;
        expect(oldUnsubscribe).toHaveBeenCalledOnce();
        expect(currentUnsubscribe).not.toHaveBeenCalled();
        await watcher.close();
        expect(currentUnsubscribe).toHaveBeenCalledOnce();
        expect(hub.snapshot().entries).toHaveLength(0);
        await hub.close();
    });

    it('waits for pending native registration and disposal before closing', async () => {
        const subscription = Promise.withResolvers<parcelWatcher.AsyncSubscription>();
        const disposed = Promise.withResolvers<void>();
        const unsubscribe = vi.fn(() => disposed.promise);
        const subscribe = vi.fn<typeof parcelWatcher.subscribe>(() => subscription.promise);
        const { watcher } = createWatcher(subscribe);
        const watching = watcher.watch('/repo/.git', '/repo', ['/repo']);
        const closed = vi.fn();
        const closing = (async () => {
            await watcher.close();
            closed();
        })();
        subscription.resolve({ unsubscribe });
        await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
        expect(closed).not.toHaveBeenCalled();
        disposed.resolve();
        await Promise.all([watching, closing]);
        expect(closed).toHaveBeenCalledOnce();
    });

    it('keeps all live child groups instead of evicting their parent at the recency limit', async () => {
        const roots = Array.from({ length: 18 }, (_, index) => `/repo-${index}`);
        const keys = new Set(roots.map((root) => `${root}/.git`));
        const unsubscribe = vi.fn(() => Promise.resolve());
        const subscribe = vi.fn<typeof parcelWatcher.subscribe>(() =>
            Promise.resolve({ unsubscribe }),
        );
        const { watcher } = createWatcher(subscribe, { referencedRepositoryKeys: () => keys });
        await Promise.all(roots.map((root) => watcher.watch(`${root}/.git`, root, [root])));
        expect(unsubscribe).not.toHaveBeenCalled();
        await Promise.all(roots.map((root) => watcher.watch(`${root}/.git`, root, [root])));
        expect(subscribe).toHaveBeenCalledTimes(18);
        await watcher.close();
        expect(unsubscribe).toHaveBeenCalledTimes(18);
    });

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
            /**
             * These paths do not exist, so no `HEAD` can be read and the ref cannot be attributed to one worktree.
             * Being unable to narrow must widen back to the whole group rather than drop the refresh.
             */
            callback?.(null, [{ type: 'update', path: '/repo/.git/refs/heads/main' }]);
            await vi.waitFor(() =>
                expect(onStatusChanged).toHaveBeenCalledWith('/repo/.git', ['/repo', '/linked']),
            );
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
        const closing = watcher.close();
        resolve({ unsubscribe });
        await watching;
        await closing;

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
