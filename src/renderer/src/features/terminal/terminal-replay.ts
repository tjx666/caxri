/**
 * Match Runtime's delivery batch ceiling while also bounding many tiny IPC events.
 */
const DEFAULT_MAXIMUM_PENDING_BYTES = 256 * 1024;
const DEFAULT_MAXIMUM_PENDING_ITEMS = 256;
const textEncoder = new TextEncoder();

export interface TerminalReplayBufferOptions {
    maximumPendingBytes?: number;
    maximumPendingItems?: number;
}

function utf8ByteLength(value: string): number {
    return textEncoder.encode(value).byteLength;
}

function utf8Prefix(value: string, maximumBytes: number): string {
    let bytes = 0;
    let end = 0;
    while (end < value.length) {
        const codePoint = value.codePointAt(end) ?? 0;
        const width = codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;
        if (bytes + width > maximumBytes) break;
        bytes += width;
        end += codePoint > 0xffff ? 2 : 1;
    }
    return value.slice(0, end);
}

/**
 * Orders output received during terminal attachment behind its restored snapshot.
 */
export class TerminalReplayBuffer {
    private restored = false;
    private restoration?: Promise<void>;
    private readonly pending: string[] = [];
    private pendingBytes = 0;
    private droppedBytes = 0;
    private readonly maximumPendingBytes: number;
    private readonly maximumPendingItems: number;

    constructor(
        private readonly write: (value: string) => Promise<void>,
        options: TerminalReplayBufferOptions = {},
    ) {
        this.maximumPendingBytes = options.maximumPendingBytes ?? DEFAULT_MAXIMUM_PENDING_BYTES;
        this.maximumPendingItems = options.maximumPendingItems ?? DEFAULT_MAXIMUM_PENDING_ITEMS;
        if (!Number.isSafeInteger(this.maximumPendingBytes) || this.maximumPendingBytes < 1)
            throw new RangeError('Terminal replay byte limit must be a positive integer');
        if (!Number.isSafeInteger(this.maximumPendingItems) || this.maximumPendingItems < 1)
            throw new RangeError('Terminal replay item limit must be a positive integer');
    }

    private async restoreOnce(snapshot: string): Promise<void> {
        if (snapshot) await this.write(snapshot);
        await this.drainPending();
    }

    /**
     * Preserve xterm write order while draining output that may continue arriving during a write. Each captured batch
     * is serialized, then a later batch picks up anything queued meanwhile.
     */
    private async drainPending(): Promise<void> {
        // The removed elements are the batch being drained below, so `.length = 0` would discard
        // them; this call intentionally both empties `this.pending` and captures its prior contents.
        // eslint-disable-next-line unicorn/no-unnecessary-splice -- return value is used, see above
        const pending = this.pending.splice(0);
        this.pendingBytes = 0;
        await this.writeBatch(pending);
        if (this.pending.length > 0) return this.drainPending();
        if (this.droppedBytes > 0) {
            const droppedBytes = this.droppedBytes;
            this.droppedBytes = 0;
            const marker = this.write(
                `\r\n[Caxri dropped ${droppedBytes} bytes while terminal output was replaying]\r\n`,
            );
            /**
             * Later output follows the marker directly, so a blocked marker cannot reopen the queue.
             */
            this.restored = true;
            await marker;
            return;
        }
        this.restored = true;
    }

    private enqueue(value: string): void {
        const bytes = utf8ByteLength(value);
        if (this.droppedBytes > 0) {
            this.droppedBytes += bytes;
            return;
        }
        const availableBytes = this.maximumPendingBytes - this.pendingBytes;
        if (this.pending.length >= this.maximumPendingItems || availableBytes <= 0) {
            this.droppedBytes += bytes;
            return;
        }
        if (bytes <= availableBytes) {
            this.pending.push(value);
            this.pendingBytes += bytes;
            return;
        }
        const prefix = utf8Prefix(value, availableBytes);
        const prefixBytes = utf8ByteLength(prefix);
        if (prefix) {
            this.pending.push(prefix);
            this.pendingBytes += prefixBytes;
        }
        this.droppedBytes += bytes - prefixBytes;
    }

    private async writeBatch(pending: readonly string[], index = 0): Promise<void> {
        const value = pending[index];
        if (value === undefined) return;
        await this.write(value);
        return this.writeBatch(pending, index + 1);
    }

    push(value: string): void {
        if (this.restored)
            // This is a sync buffer API; once restored, output is written straight through and any
            // failure is already surfaced by `write`'s own caller-side handling.
            // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
            void this.write(value);
        else this.enqueue(value);
    }

    restore(snapshot: string): Promise<void> {
        this.restoration ??= this.restoreOnce(snapshot);
        return this.restoration;
    }
}

/**
 * Replaces an already-mounted xterm from a fresh Runtime snapshot without losing live output.
 */
export class TerminalReplayCoordinator {
    private readonly initial = Promise.withResolvers<void>();
    private replay: TerminalReplayBuffer;
    private tail: Promise<void>;

    constructor(
        private readonly write: (value: string) => Promise<void>,
        private readonly reset: () => void,
        private readonly replayOptions: TerminalReplayBufferOptions = {},
    ) {
        this.replay = new TerminalReplayBuffer(write, replayOptions);
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
        const task = (async (): Promise<void> => {
            await this.tail;
            const replay = new TerminalReplayBuffer(this.write, this.replayOptions);
            this.replay = replay;
            try {
                const snapshot = await loadSnapshot();
                this.reset();
                await replay.restore(snapshot);
            } catch (error) {
                /**
                 * Keep the existing screen on an attach failure, but release output buffered while the Runtime request
                 * was pending.
                 */
                await replay.restore('');
                throw error;
            }
        })();
        this.tail = settleQuietly(task);
        return task;
    }
}

/**
 * `tail` must never reject, or the next `reattach` call's `await this.tail` would throw before it ever starts its own
 * attach attempt. The caller-visible failure still surfaces through the returned `task` in `reattach`.
 */
async function settleQuietly(task: Promise<void>): Promise<void> {
    try {
        await task;
    } catch {
        // Intentionally swallowed, see the function comment above.
    }
}
