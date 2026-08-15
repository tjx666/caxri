export class SingleFlight<Key, Value> {
    private readonly pending = new Map<Key, Promise<Value>>();

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
}
