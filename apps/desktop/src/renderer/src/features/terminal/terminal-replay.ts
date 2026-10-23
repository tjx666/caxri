import type { TerminalOscLinkSnapshot } from '@caxri/protocol';

/**
 * Match Server's delivery batch ceiling while also bounding many tiny IPC events.
 */
const DEFAULT_MAXIMUM_PENDING_BYTES = 256 * 1024;
const DEFAULT_MAXIMUM_PENDING_ITEMS = 256;
const textEncoder = new TextEncoder();

export interface TerminalReplayBufferOptions {
    maximumPendingBytes?: number;
    maximumPendingItems?: number;
    /**
     * Requests an authoritative screen snapshot when replay output develops a gap.
     */
    onDroppedOutput?: (droppedBytes: number) => void;
}

export interface TerminalReplaySnapshot {
    cols: number;
    oscLinks?: readonly TerminalOscLinkSnapshot[];
    payload: string;
    rows: number;
}

export interface TerminalReplayCoordinatorOptions extends TerminalReplayBufferOptions {
    /**
     * Pauses layout-driven fitting before a snapshot request can observe or restore the source grid.
     */
    beginSnapshot?: () => void;
    /**
     * Locks xterm to the source grid immediately before a serialized framebuffer is parsed.
     */
    prepareSnapshot?: (snapshot: TerminalReplaySnapshot) => void;
    /**
     * Restores hyperlink identity after the serialized cells parse but before live output queued behind the snapshot.
     */
    restoreSnapshotLinks?: (snapshot: TerminalReplaySnapshot) => void;
    /**
     * Restores normal pane fitting only after the snapshot and queued output have finished parsing.
     */
    finishSnapshot?: () => void;
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
        private readonly options: TerminalReplayBufferOptions = {},
    ) {
        this.maximumPendingBytes =
            this.options.maximumPendingBytes ?? DEFAULT_MAXIMUM_PENDING_BYTES;
        this.maximumPendingItems =
            this.options.maximumPendingItems ?? DEFAULT_MAXIMUM_PENDING_ITEMS;
        if (!Number.isSafeInteger(this.maximumPendingBytes) || this.maximumPendingBytes < 1)
            throw new RangeError('Terminal replay byte limit must be a positive integer');
        if (!Number.isSafeInteger(this.maximumPendingItems) || this.maximumPendingItems < 1)
            throw new RangeError('Terminal replay item limit must be a positive integer');
    }

    private async restoreOnce(snapshot: string, afterSnapshot?: () => void): Promise<void> {
        if (snapshot) await this.write(snapshot);
        afterSnapshot?.();
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
            const onDroppedOutput = this.options.onDroppedOutput;
            if (onDroppedOutput) {
                /**
                 * The callback synchronously redirects later output into a replacement replay buffer, so reopen this
                 * buffer before invoking it without exposing output after the known gap to the stale screen.
                 */
                this.restored = true;
                onDroppedOutput(droppedBytes);
                return;
            }
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
        // `.at()` (rather than `[index]`) keeps the recursion's out-of-range terminal case in the type, since this
        // project does not enable `noUncheckedIndexedAccess`.
        const value = pending.at(index);
        if (value === undefined) return;
        await this.write(value);
        return this.writeBatch(pending, index + 1);
    }

    push(value: string): void {
        if (this.restored)
            // This is a sync buffer API; once restored, output is written straight through and any
            // failure is already surfaced by `write`'s own caller-side handling.
            void this.write(value);
        else this.enqueue(value);
    }

    restore(snapshot: string, afterSnapshot?: () => void): Promise<void> {
        this.restoration ??= this.restoreOnce(snapshot, afterSnapshot);
        return this.restoration;
    }
}

/**
 * Serializes authoritative screen recovery while preserving one follow-up attempt when more output is dropped during an
 * in-flight snapshot. Each follow-up is caused by a new gap instead of an unbounded timer-based retry loop.
 */
export class TerminalBackpressureRecovery {
    private active = false;
    private disposed = false;
    private pending = false;

    constructor(
        private readonly reattach: () => Promise<void>,
        private readonly onFailure: (error: unknown) => void,
    ) {}

    private async recover(): Promise<void> {
        this.pending = false;
        try {
            await this.reattach();
        } catch (error) {
            // TypeScript preserves the pre-await narrowing, but pane disposal can set this flag while attachment is
            // pending and must suppress a teardown-time error toast.
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
            if (!this.disposed) this.onFailure(error);
        } finally {
            this.active = false;
            /**
             * Start a detached follow-up instead of awaiting recursively, so a continuously noisy Terminal cannot
             * retain an ever-growing promise chain while still allowing only one attachment at a time. TypeScript
             * cannot see `request()` or `dispose()` mutating these fields during the await above.
             */
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
            if (this.pending && !this.disposed) this.request();
        }
    }

    dispose(): void {
        this.disposed = true;
        this.pending = false;
    }

    request(): void {
        if (this.disposed) return;
        this.pending = true;
        if (this.active) return;
        this.active = true;
        // This synchronous API owns failure reporting through `onFailure`.
        void this.recover();
    }
}

/**
 * Replaces an already-mounted xterm from a fresh Server snapshot without losing live output.
 */
export class TerminalReplayCoordinator {
    private disposed = false;
    private readonly initial = Promise.withResolvers<void>();
    private readonly initialReplay: TerminalReplayBuffer;
    private replay: TerminalReplayBuffer;
    private tail: Promise<void>;

    constructor(
        private readonly write: (value: string) => Promise<void>,
        private readonly reset: () => void,
        private readonly replayOptions: TerminalReplayCoordinatorOptions = {},
    ) {
        this.initialReplay = new TerminalReplayBuffer(write, replayOptions);
        this.replay = this.initialReplay;
        this.tail = this.initial.promise;
    }

    push(value: string): void {
        if (this.disposed) return;
        this.replay.push(value);
    }

    async restoreInitial(snapshot: TerminalReplaySnapshot | null): Promise<void> {
        if (this.disposed) {
            this.initial.resolve();
            return;
        }
        this.replayOptions.beginSnapshot?.();
        try {
            if (snapshot) this.replayOptions.prepareSnapshot?.(snapshot);
            await this.initialReplay.restore(snapshot?.payload ?? '', () => {
                if (snapshot && !this.disposed) this.replayOptions.restoreSnapshotLinks?.(snapshot);
            });
        } finally {
            this.replayOptions.finishSnapshot?.();
            this.initial.resolve();
        }
    }

    reattach(loadSnapshot: () => Promise<TerminalReplaySnapshot | null>): Promise<void> {
        if (this.disposed) return Promise.resolve();
        const previousTail = this.tail;
        /**
         * Swap buffers before waiting for an older attachment. A later discontinuity can then queue output behind its
         * own authoritative snapshot instead of briefly leaking it into the screen that is about to be replaced.
         */
        const replay = new TerminalReplayBuffer(this.write, this.replayOptions);
        this.replay = replay;
        const task = (async (): Promise<void> => {
            await previousTail;
            // Disposal resolves the initial barrier so a queued attachment can release all captured pane state.
            if (this.disposed) return;
            this.replayOptions.beginSnapshot?.();
            try {
                const snapshot = await loadSnapshot();
                // The pane may be removed while Server is serializing its parsed screen.
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- changed across await
                if (this.disposed) return;
                if (snapshot) this.replayOptions.prepareSnapshot?.(snapshot);
                this.reset();
                await replay.restore(snapshot?.payload ?? '', () => {
                    if (snapshot && !this.disposed)
                        this.replayOptions.restoreSnapshotLinks?.(snapshot);
                });
            } catch (error) {
                // A teardown-time request failure has no surviving view to notify or replay into.
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- changed across await
                if (this.disposed) return;
                /**
                 * Keep the existing screen on an attach failure, but release output buffered while the Server request
                 * was pending.
                 */
                await replay.restore('');
                throw error;
            } finally {
                this.replayOptions.finishSnapshot?.();
            }
        })();
        this.tail = settleQuietly(task);
        return task;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.initial.resolve();
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
