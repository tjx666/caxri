import { describe, expect, it } from 'vitest';

import { createTerminalOutputQueue } from '../output-queue';

describe('mobile Terminal output queue', () => {
    it('counts UTF-8 bytes, including multibyte characters', () => {
        const queue = createTerminalOutputQueue(8);
        expect(queue.push(['A', '中', '😀'])).toBe(true);
        expect(queue.length).toBe(3);
        expect(queue.push(['B'])).toBe(false);
        expect(queue.shift()).toBe('A');
        expect(queue.push(['B'])).toBe(true);
        expect(queue.shift()).toBe('中');
        expect(queue.shift()).toBe('😀');
        expect(queue.shift()).toBe('B');
        expect(queue.shift()).toBeUndefined();
    });

    it('accepts output at the exact capacity', () => {
        const queue = createTerminalOutputQueue(4);
        expect(queue.push(['é', 'é'])).toBe(true);
        expect(queue.length).toBe(2);
        expect(queue.push(['x'])).toBe(false);
    });

    it('leaves existing output unchanged when a multi-chunk push overflows', () => {
        const queue = createTerminalOutputQueue(5);
        expect(queue.push(['old'])).toBe(true);
        expect(queue.push(['x', 'yy'])).toBe(false);
        expect(queue.length).toBe(1);
        expect(queue.shift()).toBe('old');
        expect(queue.shift()).toBeUndefined();
    });

    it('releases capacity when shifting and clears pending output', () => {
        const queue = createTerminalOutputQueue(3);
        expect(queue.push(['ab', 'c'])).toBe(true);
        expect(queue.shift()).toBe('ab');
        expect(queue.push(['de'])).toBe(true);
        expect(queue.length).toBe(2);
        queue.clear();
        expect(queue.length).toBe(0);
        expect(queue.shift()).toBeUndefined();
        expect(queue.push(['abc'])).toBe(true);
    });

    it('does not retain unlimited empty chunks', () => {
        const queue = createTerminalOutputQueue(1);
        expect(queue.push(['', 'a', ''])).toBe(true);
        expect(queue.length).toBe(1);
        expect(queue.shift()).toBe('a');
    });
});
