export class SingleFlight<Key, Value> {
    private readonly pending = new Map<Key, Promise<Value>>();

    run(key: Key, load: () => Promise<Value>): Promise<Value> {
        const existing = this.pending.get(key);
        if (existing) return existing;
        const request = Promise.resolve()
            .then(load)
            .finally(() => {
                if (this.pending.get(key) === request) this.pending.delete(key);
            });
        this.pending.set(key, request);
        return request;
    }
}
