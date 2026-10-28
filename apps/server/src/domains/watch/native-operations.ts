import type parcelWatcher from '@parcel/watcher';

/**
 * Tracks every in-flight `@parcel/watcher` subscribe and unsubscribe so `WatchHub.close()` can wait for all of them. A
 * process that exits while a native FSEvents subscription is still live can crash on the backend's callback thread
 * (`DirTree::remove` locking an already destroyed mutex), as reported in
 * https://github.com/parcel-bundler/watcher/issues/258. Closing must therefore cover a subscribe that settles after
 * `close()` started and a release that fallback activation deliberately does not await.
 */
export class NativeWatchOperations {
    private readonly pending = new Set<Promise<unknown>>();

    private async forgetWhenSettled(operation: Promise<unknown>): Promise<void> {
        try {
            await operation;
        } catch {
            // The caller owns the failure; tracking only needs the settlement.
        } finally {
            this.pending.delete(operation);
        }
    }

    track<T>(operation: Promise<T>): Promise<T> {
        this.pending.add(operation);
        void this.forgetWhenSettled(operation);
        return operation;
    }

    async release(subscription: parcelWatcher.AsyncSubscription): Promise<void> {
        try {
            await this.track(subscription.unsubscribe());
        } catch {
            // Releasing a dead native subscription must not mask shutdown or fallback activation.
        }
    }

    /**
     * Repeats because a subscribe that settles during the wait queues its own release.
     */
    async drain(): Promise<void> {
        if (this.pending.size === 0) return;
        await Promise.allSettled(this.pending);
        await this.drain();
    }
}
