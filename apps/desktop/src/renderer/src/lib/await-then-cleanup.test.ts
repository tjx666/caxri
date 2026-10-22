import { describe, expect, it, vi } from 'vitest';

import { awaitThenCleanup, runThenCleanup } from './await-then-cleanup';

describe('awaitThenCleanup', () => {
    it('returns the value and cleans up after it resolved', async () => {
        const cleanup = vi.fn();
        await expect(awaitThenCleanup(Promise.resolve(3), cleanup)).resolves.toBe(3);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('cleans up and still rejects when the work failed', async () => {
        const cleanup = vi.fn();
        const failing = Promise.reject(new Error('boom'));
        await expect(awaitThenCleanup(failing, cleanup)).rejects.toThrow('boom');
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
});

describe('runThenCleanup', () => {
    it('returns the value and cleans up after it', () => {
        const cleanup = vi.fn();
        expect(runThenCleanup(() => 3, cleanup)).toBe(3);
        expect(cleanup).toHaveBeenCalledTimes(1);
    });

    it('cleans up and still throws when the work failed', () => {
        const cleanup = vi.fn();
        expect(() =>
            runThenCleanup(() => {
                throw new Error('boom');
            }, cleanup),
        ).toThrow('boom');
        expect(cleanup).toHaveBeenCalledTimes(1);
    });
});
