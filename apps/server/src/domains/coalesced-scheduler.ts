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
                // `setTimeout`'s callback is synchronous, so this cannot become `await`; `run` is
                // responsible for handling its own rejections (as `AgentCoordinator#probe` does).
                // eslint-disable-next-line unicorn/prefer-await -- sync timer callback, see comment above
                Promise.resolve(this.run(key)).catch(() => {});
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
