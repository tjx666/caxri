import { describe, expect, it } from 'vitest';

import { TerminalOutputQueue } from '../buffer';

describe('Terminal buffers', () => {
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
