/**
 * Runs tasks that share a key strictly one after another in arrival order, while tasks with different keys do not wait
 * for each other. Unlike `SingleFlight`, no caller joins or skips another's work: every task runs, and a failed
 * predecessor never blocks or poisons its successors (its rejection reaches only its own caller).
 */
export class KeyedSerialQueue<Key> {
    private readonly tails = new Map<Key, Promise<void>>();

    /**
     * Starts `task` immediately when nothing is queued for `key`, otherwise after every earlier task for `key` settled.
     */
    async run<Result>(key: Key, task: () => Promise<Result> | Result): Promise<Result> {
        const previous = this.tails.get(key);
        const release = Promise.withResolvers<void>();
        this.tails.set(key, release.promise);
        if (previous) await previous;
        try {
            return await task();
        } finally {
            release.resolve();
            if (this.tails.get(key) === release.promise) this.tails.delete(key);
        }
    }

    /**
     * Resolves once the tasks queued for `key` so far have settled, whether they succeeded or failed.
     */
    async settled(key: Key): Promise<void> {
        await this.tails.get(key);
    }
}
