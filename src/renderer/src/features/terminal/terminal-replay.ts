/** Orders output received during terminal attachment behind its restored snapshot. */
export class TerminalReplayBuffer {
    private restored = false;
    private restoration?: Promise<void>;
    private readonly pending: string[] = [];

    constructor(private readonly write: (value: string) => Promise<void>) {}

    push(value: string): void {
        if (this.restored) void this.write(value);
        else this.pending.push(value);
    }

    restore(snapshot: string): Promise<void> {
        this.restoration ??= this.restoreOnce(snapshot);
        return this.restoration;
    }

    private async restoreOnce(snapshot: string): Promise<void> {
        if (snapshot) await this.write(snapshot);
        await this.drainPending();
    }

    /**
     * Preserve xterm write order while draining output that may continue arriving during a write.
     * Each captured batch is serialized, then a later batch picks up anything queued meanwhile.
     */
    private async drainPending(): Promise<void> {
        const pending = this.pending.splice(0);
        await this.writeBatch(pending);
        if (this.pending.length > 0) return this.drainPending();
        this.restored = true;
    }

    private async writeBatch(pending: readonly string[], index = 0): Promise<void> {
        const value = pending[index];
        if (value === undefined) return;
        await this.write(value);
        return this.writeBatch(pending, index + 1);
    }
}

/** Replaces an already-mounted xterm from a fresh Runtime snapshot without losing live output. */
export class TerminalReplayCoordinator {
    private readonly initial = Promise.withResolvers<void>();
    private replay: TerminalReplayBuffer;
    private tail: Promise<void>;

    constructor(
        private readonly write: (value: string) => Promise<void>,
        private readonly reset: () => void,
    ) {
        this.replay = new TerminalReplayBuffer(write);
        this.tail = this.initial.promise;
    }

    push(value: string): void {
        this.replay.push(value);
    }

    async restoreInitial(snapshot: string): Promise<void> {
        try {
            await this.replay.restore(snapshot);
        } finally {
            this.initial.resolve();
        }
    }

    reattach(loadSnapshot: () => Promise<string>): Promise<void> {
        const task = this.tail.then(async () => {
            const replay = new TerminalReplayBuffer(this.write);
            this.replay = replay;
            try {
                const snapshot = await loadSnapshot();
                this.reset();
                await replay.restore(snapshot);
            } catch (error) {
                /** Keep the existing screen on an attach failure, but release output buffered while
                 *  the Runtime request was pending. */
                await replay.restore('');
                throw error;
            }
        });
        this.tail = task.catch(() => undefined);
        return task;
    }
}
