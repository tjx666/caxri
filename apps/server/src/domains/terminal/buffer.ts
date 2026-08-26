import { Buffer } from 'node:buffer';

/**
 * Maintains a bounded Renderer delivery queue with constant-time byte accounting.
 */
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

    /**
     * Appends one control sequence in full or drops it in full, never exposing a partial parser state.
     */
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
