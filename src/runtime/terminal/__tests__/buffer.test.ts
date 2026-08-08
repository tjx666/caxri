import { describe, expect, it } from 'vitest';

import { boundSnapshot, MAX_SNAPSHOT_BYTES } from '../../snapshot';
import { TerminalOutputQueue, TerminalSnapshotBuffer } from '../buffer';

describe('Terminal buffers', () => {
    it('appends small PTY chunks without rescanning a saturated snapshot', () => {
        const buffer = new TerminalSnapshotBuffer('x'.repeat(MAX_SNAPSHOT_BYTES));
        const startedAt = performance.now();
        for (let index = 0; index < 1_000; index += 1) buffer.append(String(index % 10));

        expect(performance.now() - startedAt).toBeLessThan(100);
        expect(buffer.read().byteCount).toBeLessThanOrEqual(MAX_SNAPSHOT_BYTES);
    });

    it('matches the reference line and UTF-8 byte bounds across chunk boundaries', () => {
        const chunks = [
            `${'old\n'.repeat(2_050)}prefix`,
            '界'.repeat(MAX_SNAPSHOT_BYTES),
            '\nnewest-line',
        ];
        const buffer = new TerminalSnapshotBuffer('initial\n');
        for (const chunk of chunks) buffer.append(chunk);

        expect(buffer.read()).toEqual(boundSnapshot(`initial\n${chunks.join('')}`));
    });

    it('tracks whether a changed snapshot has been persisted', () => {
        const buffer = new TerminalSnapshotBuffer('restored');
        expect(buffer.hasUnpersistedChanges()).toBe(false);
        buffer.append(' output');
        expect(buffer.hasUnpersistedChanges()).toBe(true);
        buffer.markPersisted();
        expect(buffer.hasUnpersistedChanges()).toBe(false);
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
