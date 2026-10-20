export class SingleFlight<Key, Value> {
    private readonly pending = new Map<Key, Promise<Value>>();
    private readonly trailing = new Map<Key, Promise<Value>>();

    /**
     * Waits for the in-flight load to settle before starting `load`. A plain caller may start another load in the gap
     * between settlement and this continuation, so re-check instead of assuming the slot is free.
     */
    private async runOnceSettled(key: Key, load: () => Promise<Value>): Promise<Value> {
        const inFlight = this.pending.get(key);
        if (!inFlight) {
            this.trailing.delete(key);
            return this.run(key, load);
        }
        await Promise.allSettled([inFlight]);
        return this.runOnceSettled(key, load);
    }

    /**
     * Forgets every in-flight and queued load without cancelling it, so the next caller starts a fresh one instead of
     * joining work that began under the state a reset just discarded. For a test or benchmark resetting the cache this
     * sits in front of; a load already running still settles and still resolves its original callers.
     */
    clear(): void {
        this.pending.clear();
        this.trailing.clear();
    }

    /**
     * Reports whether a trailing load is already waiting behind the in-flight load for `key`.
     */
    isQueued(key: Key): boolean {
        return this.trailing.has(key);
    }

    /**
     * Reports whether a caller would join an in-flight load instead of starting a fresh one.
     */
    has(key: Key): boolean {
        return this.pending.has(key);
    }

    /**
     * The in-flight load for `key`, if any, so a caller can sequence work after it without starting a new load.
     */
    get(key: Key): Promise<Value> | undefined {
        return this.pending.get(key);
    }

    run(key: Key, load: () => Promise<Value>): Promise<Value> {
        const existing = this.pending.get(key);
        if (existing) return existing;
        // The `.finally()` callback closes over `request` itself to evict only its own cache entry, so
        // `request` must exist as a Promise before this statement completes; `await` here would forfeit
        // that self-reference.
        // eslint-disable-next-line unicorn/prefer-await -- self-referential promise, see comment above
        const request = Promise.try(load).finally(() => {
            if (this.pending.get(key) === request) this.pending.delete(key);
        });
        this.pending.set(key, request);
        return request;
    }

    /**
     * Starts `load` now when nothing is in flight for `key`, otherwise queues it to start once the in-flight load
     * settles. Callers arriving while the queued load is still waiting share it; once it starts it is simply the
     * in-flight load, so a later caller queues its own trailing load instead of joining a result that may predate it.
     */
    runAfter(key: Key, load: () => Promise<Value>): Promise<Value> {
        if (!this.pending.has(key)) return this.run(key, load);
        const queued = this.trailing.get(key);
        if (queued) return queued;
        const trailing = this.runOnceSettled(key, load);
        this.trailing.set(key, trailing);
        return trailing;
    }
}
