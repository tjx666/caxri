import { Buffer } from 'node:buffer';

import { boundSnapshot, MAX_SNAPSHOT_BYTES } from './snapshot';

type BoundedSnapshot = ReturnType<typeof boundSnapshot>;

/** Buffers PTY output so the bounded snapshot is compacted in batches instead of rescanned per chunk. */
export class TerminalSnapshotBuffer {
    private current: BoundedSnapshot;
    private readonly pending: string[] = [];
    private pendingByteCount = 0;

    constructor(initial: string) {
        this.current = boundSnapshot(initial);
    }

    append(data: string): void {
        this.pending.push(data);
        this.pendingByteCount += Buffer.byteLength(data, 'utf8');
        if (this.pendingByteCount >= MAX_SNAPSHOT_BYTES * 2) this.compact();
    }

    read(): BoundedSnapshot {
        this.compact();
        return this.current;
    }

    private compact(): void {
        if (this.pending.length === 0) return;
        this.current = boundSnapshot(this.current.payload + this.pending.join(''));
        this.pending.length = 0;
        this.pendingByteCount = 0;
    }
}

/** Maintains a bounded Renderer delivery queue with constant-time byte accounting. */
export class TerminalOutputQueue {
    private readonly chunks: string[] = [];
    byteCount = 0;

    constructor(private readonly maxBytes: number) {}

    appendBounded(data: string): number {
        const buffer = Buffer.from(data, 'utf8');
        const available = this.maxBytes - this.byteCount;
        if (buffer.length <= available) {
            this.chunks.push(data);
            this.byteCount += buffer.length;
            return 0;
        }
        let end = Math.max(0, available);
        while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
        const prefix = buffer.subarray(0, end).toString('utf8');
        if (prefix) {
            this.chunks.push(prefix);
            this.byteCount += end;
        }
        return buffer.length - end;
    }

    drain(): string {
        const value = this.chunks.join('');
        this.clear();
        return value;
    }

    clear(): void {
        this.chunks.length = 0;
        this.byteCount = 0;
    }
}
