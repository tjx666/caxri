export class CoalescedScheduler<Key> {
    private readonly timers = new Map<Key, NodeJS.Timeout>();

    constructor(
        private readonly delayMs: number,
        private readonly run: (key: Key) => void | Promise<void>,
    ) {}

    schedule(key: Key): void {
        if (this.timers.has(key)) return;
        this.timers.set(
            key,
            setTimeout(() => {
                this.timers.delete(key);
                void this.run(key);
            }, this.delayMs),
        );
    }

    cancel(key: Key): void {
        const timer = this.timers.get(key);
        if (timer) clearTimeout(timer);
        this.timers.delete(key);
    }

    close(): void {
        for (const timer of this.timers.values()) clearTimeout(timer);
        this.timers.clear();
    }
}
