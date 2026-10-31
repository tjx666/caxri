interface BoundedSerialBatcherOptions<Key> {
    capacity: number;
    delayMs: number;
    onCapacity(): void;
    run(keys: readonly Key[]): Promise<void>;
}

/**
 * Coalesces a high-frequency lifecycle boundary into one active batch plus one bounded pending set. New keys received
 * while Git work is in flight cannot append promise-chain nodes; they become one later batch instead.
 */
export class BoundedSerialBatcher<Key> {
    private readonly pending = new Set<Key>();
    private active = false;
    private closed = false;
    private timer?: NodeJS.Timeout;

    constructor(private readonly options: BoundedSerialBatcherOptions<Key>) {}

    private arm(): void {
        if (this.active || this.closed || this.timer || this.pending.size === 0) return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, this.options.delayMs);
        this.timer.unref();
    }

    private flush(): void {
        if (this.active || this.closed) return;
        const keys = [...this.pending];
        this.pending.clear();
        this.active = true;
        // The lifecycle callback is synchronous; the batch owns and contains its asynchronous failure.
        void this.options
            .run(keys)
            .catch(() => {})
            .finally(() => {
                this.active = false;
                this.arm();
            });
    }

    schedule(key: Key): boolean {
        if (this.closed) return false;
        if (!this.pending.has(key) && this.pending.size >= this.options.capacity) {
            this.options.onCapacity();
            return false;
        }
        this.pending.add(key);
        this.arm();
        return true;
    }

    close(): void {
        this.closed = true;
        if (this.timer) clearTimeout(this.timer);
        this.timer = undefined;
        this.pending.clear();
    }
}
