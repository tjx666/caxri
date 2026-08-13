import { Buffer } from 'node:buffer';

import { boundSnapshot, MAX_SNAPSHOT_BYTES, MAX_SNAPSHOT_LINES } from '../snapshot';

type BoundedSnapshot = ReturnType<typeof boundSnapshot>;
const SNAPSHOT_TRIM_BATCH_BYTES = 64 * 1024;

interface SnapshotChunk {
    byteCount: number;
    newlineCount: number;
    text: string;
}

function countNewlines(text: string): number {
    let count = 0;
    for (let index = 0; index < text.length; index += 1)
        if (text.charCodeAt(index) === 10) count += 1;
    return count;
}

function toChunk(text: string): SnapshotChunk {
    return {
        byteCount: Buffer.byteLength(text, 'utf8'),
        newlineCount: countNewlines(text),
        text,
    };
}

/**
 * Keeps bounded PTY output as chunks so appends trim only the oldest prefix. A snapshot read joins
 * the retained chunks once; it never builds a full string and then splits that second copy by line.
 */
export class TerminalSnapshotBuffer {
    private chunks: SnapshotChunk[];
    private byteCount: number;
    private newlineCount: number;
    private cached?: BoundedSnapshot;
    private revision = 0;
    private persistedRevision = 0;

    constructor(
        initial: string,
        private readonly maximumBytes = MAX_SNAPSHOT_BYTES,
    ) {
        if (!Number.isInteger(maximumBytes) || maximumBytes < 1)
            throw new RangeError('Terminal snapshot byte limit must be a positive integer');
        const bounded = boundSnapshot(initial);
        this.chunks = bounded.payload ? [toChunk(bounded.payload)] : [];
        this.byteCount = bounded.byteCount;
        this.newlineCount = Math.max(0, bounded.lineCount - 1);
        this.trimBytes(true);
    }

    append(data: string): void {
        if (!data) return;
        const chunk = toChunk(data);
        this.chunks.push(chunk);
        this.byteCount += chunk.byteCount;
        this.newlineCount += chunk.newlineCount;
        this.revision += 1;
        this.cached = undefined;
        this.trimLines();
        this.trimBytes();
    }

    read(): BoundedSnapshot {
        this.trimBytes(true);
        this.cached ??= {
            payload: this.chunks.map((chunk) => chunk.text).join(''),
            lineCount: Math.min(this.newlineCount + 1, MAX_SNAPSHOT_LINES),
            byteCount: this.byteCount,
        };
        return this.cached;
    }

    hasUnpersistedChanges(): boolean {
        return this.revision !== this.persistedRevision;
    }

    markPersisted(): void {
        this.persistedRevision = this.revision;
    }

    private trimLines(): void {
        let excess = this.newlineCount + 1 - MAX_SNAPSHOT_LINES;
        while (excess > 0 && this.chunks.length > 0) {
            const first = this.chunks[0];
            if (first.newlineCount < excess) {
                this.removeFirstChunk();
                excess -= first.newlineCount;
                continue;
            }
            let start = 0;
            for (let count = 0; count < excess; count += 1)
                start = first.text.indexOf('\n', start) + 1;
            this.replaceFirstChunk(first.text.slice(start));
            excess = 0;
        }
    }

    private trimBytes(force = false): void {
        let excess = this.byteCount - this.maximumBytes;
        if (!force && excess < SNAPSHOT_TRIM_BATCH_BYTES) return;
        while (excess > 0 && this.chunks.length > 0) {
            const first = this.chunks[0];
            if (first.byteCount <= excess) {
                this.removeFirstChunk();
                excess -= first.byteCount;
                continue;
            }
            const buffer = Buffer.from(first.text, 'utf8');
            let start = excess;
            while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
            this.replaceFirstChunk(buffer.subarray(start).toString('utf8'));
            excess = 0;
        }
        this.cached = undefined;
    }

    private removeFirstChunk(): void {
        const removed = this.chunks.shift();
        if (!removed) return;
        this.byteCount -= removed.byteCount;
        this.newlineCount -= removed.newlineCount;
    }

    private replaceFirstChunk(text: string): void {
        this.removeFirstChunk();
        if (!text) return;
        const replacement = toChunk(text);
        this.chunks.unshift(replacement);
        this.byteCount += replacement.byteCount;
        this.newlineCount += replacement.newlineCount;
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

    /** Appends one control sequence in full or drops it in full, never exposing a partial parser state. */
    appendAtomic(data: string): number {
        const byteCount = Buffer.byteLength(data, 'utf8');
        if (byteCount > this.maxBytes - this.byteCount) return byteCount;
        this.chunks.push(data);
        this.byteCount += byteCount;
        return 0;
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
