import { describe, expect, it, vi } from 'vitest';

import { retryableLoader } from './retryable-loader';

describe('retryableLoader', () => {
    it('shares one load between callers and keeps a successful result', async () => {
        const load = vi.fn(() => Promise.resolve('module'));
        const get = retryableLoader(load);

        expect(await Promise.all([get(), get()])).toEqual(['module', 'module']);
        expect(await get()).toBe('module');
        expect(load).toHaveBeenCalledTimes(1);
    });

    it('forgets a rejected load so the next call retries instead of replaying the error', async () => {
        const load = vi
            .fn<() => Promise<string>>()
            .mockRejectedValueOnce(new Error('chunk failed'))
            .mockResolvedValueOnce('module');
        const get = retryableLoader(load);

        await expect(get()).rejects.toThrow('chunk failed');
        expect(await get()).toBe('module');
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('retries after a load that throws before returning a promise', async () => {
        const load = vi
            .fn<() => Promise<string>>()
            .mockImplementationOnce(() => {
                throw new Error('sync failure');
            })
            .mockResolvedValueOnce('module');
        const get = retryableLoader(load);

        await expect(get()).rejects.toThrow('sync failure');
        expect(await get()).toBe('module');
    });
});
