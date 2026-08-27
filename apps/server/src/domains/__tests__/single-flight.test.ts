import { describe, expect, it, vi } from 'vitest';

import { SingleFlight } from '../single-flight';

describe('SingleFlight', () => {
    it('shares concurrent work and permits a fresh load after settlement', async () => {
        const load = vi.fn(() => Promise.resolve('loaded'));
        const requests = new SingleFlight<string, string>();

        await expect(
            Promise.all([requests.run('same', load), requests.run('same', load)]),
        ).resolves.toEqual(['loaded', 'loaded']);
        expect(load).toHaveBeenCalledTimes(1);

        await expect(requests.run('same', load)).resolves.toBe('loaded');
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('permits a retry after a rejected load', async () => {
        const load = vi
            .fn()
            .mockRejectedValueOnce(new Error('failed'))
            .mockResolvedValueOnce('recovered');
        const requests = new SingleFlight<string, string>();

        await expect(requests.run('same', load)).rejects.toThrow('failed');
        await expect(requests.run('same', load)).resolves.toBe('recovered');
        expect(load).toHaveBeenCalledTimes(2);
    });
});
