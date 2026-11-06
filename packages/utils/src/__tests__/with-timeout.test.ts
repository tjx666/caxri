import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withTimeout } from '../with-timeout';

describe('withTimeout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves undefined when the deadline passes first', async () => {
        const result = withTimeout(new Promise<string>(() => {}), 100);
        await vi.advanceTimersByTimeAsync(100);
        await expect(result).resolves.toBeUndefined();
    });

    it('resolves the fallback when the deadline passes first', async () => {
        const result = withTimeout(new Promise<string>(() => {}), 100, { fallback: 'late' });
        await vi.advanceTimersByTimeAsync(100);
        await expect(result).resolves.toBe('late');
    });

    it('rejects with the supplied error when the deadline passes first', async () => {
        const result = withTimeout(new Promise<string>(() => {}), 100, {
            reject: () => new Error('slow'),
        });
        const assertion = expect(result).rejects.toThrow('slow');
        await vi.advanceTimersByTimeAsync(100);
        await assertion;
    });

    it('returns the value and clears the timer when the promise wins', async () => {
        const result = withTimeout(Promise.resolve(7), 100, { reject: () => new Error('x') });
        await expect(result).resolves.toBe(7);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('propagates a rejection of the promise and clears the timer', async () => {
        const failure = new Error('boom');
        await expect(withTimeout(Promise.reject(failure), 100)).rejects.toBe(failure);
        expect(vi.getTimerCount()).toBe(0);
    });
});
