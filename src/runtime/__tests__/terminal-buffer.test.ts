import { describe, expect, it } from 'vitest';

import { MAX_SNAPSHOT_BYTES } from '../snapshot';
import { TerminalOutputQueue, TerminalSnapshotBuffer } from '../terminal-buffer';

describe('Terminal buffers', () => {
    it('appends small PTY chunks without rescanning a saturated snapshot', () => {
        const buffer = new TerminalSnapshotBuffer('x'.repeat(MAX_SNAPSHOT_BYTES));
        const startedAt = performance.now();
        for (let index = 0; index < 1_000; index += 1) buffer.append(String(index % 10));

        expect(performance.now() - startedAt).toBeLessThan(100);
        expect(buffer.read().byteCount).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    });

    it('bounds queued Renderer output using a byte counter', () => {
        const queue = new TerminalOutputQueue(5);
        expect(queue.appendBounded('é')).toBe(0);
        expect(queue.appendBounded('abc')).toBe(0);
        expect(queue.appendBounded('x')).toBe(1);
        expect(queue.drain()).toBe('éabc');
        expect(queue.byteCount).toBe(0);
    });

    it('keeps the deliverable prefix of a single oversized PTY chunk', () => {
        const queue = new TerminalOutputQueue(5);

        expect(queue.appendBounded('abcdef')).toBe(1);
        expect(queue.drain()).toBe('abcde');
    });
});
