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

    it('queues one trailing load behind an in-flight load and shares it until it starts', async () => {
        const requests = new SingleFlight<string, string>();
        let releaseFirst!: () => void;
        const first = requests.run(
            'same',
            () => new Promise<string>((resolve) => (releaseFirst = () => resolve('first'))),
        );
        const trailingLoad = vi.fn(() => Promise.resolve('trailing'));
        const trailingA = requests.runAfter('same', trailingLoad);
        const trailingB = requests.runAfter('same', trailingLoad);
        expect(trailingB).toBe(trailingA);
        expect(trailingLoad).not.toHaveBeenCalled();

        releaseFirst();
        await expect(first).resolves.toBe('first');
        await expect(Promise.all([trailingA, trailingB])).resolves.toEqual([
            'trailing',
            'trailing',
        ]);
        expect(trailingLoad).toHaveBeenCalledTimes(1);

        await expect(requests.runAfter('same', trailingLoad)).resolves.toBe('trailing');
        expect(trailingLoad).toHaveBeenCalledTimes(2);
    });

    it('runs a trailing load even when the in-flight load rejects', async () => {
        const requests = new SingleFlight<string, string>();
        const failing = requests.run('same', () => Promise.reject(new Error('failed')));
        const trailing = requests.runAfter('same', () => Promise.resolve('recovered'));
        await expect(failing).rejects.toThrow('failed');
        await expect(trailing).resolves.toBe('recovered');
    });
});
