import { describe, expect, it } from 'vitest';

import { AsyncSemaphore, mapWithConcurrency } from '../concurrency';

async function verifyBounded(run: (operation: () => Promise<number>) => Promise<number>) {
    let active = 0;
    let peak = 0;
    const values = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
            run(async () => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 2));
                active -= 1;
                return index;
            }),
        ),
    );
    return { peak, values };
}

describe('bounded concurrency', () => {
    it('maps in input order without exceeding the worker budget', async () => {
        let active = 0;
        let peak = 0;
        const values = await mapWithConcurrency(
            Array.from({ length: 12 }, (_, index) => index),
            3,
            async (value) => {
                active += 1;
                peak = Math.max(peak, active);
                await new Promise((resolve) => setTimeout(resolve, 2));
                active -= 1;
                return value * 2;
            },
        );

        expect(peak).toBe(3);
        expect(values).toEqual(Array.from({ length: 12 }, (_, index) => index * 2));
    });

    it('stops queued work and drains active workers before rejecting', async () => {
        let releaseWorkers!: () => void;
        const workersReleased = new Promise<void>((resolve) => {
            releaseWorkers = resolve;
        });
        const started: number[] = [];
        const mapping = mapWithConcurrency(
            Array.from({ length: 12 }, (_, index) => index),
            3,
            async (value) => {
                started.push(value);
                if (value === 0) throw new Error('expected');
                await workersReleased;
                return value;
            },
        );
        let settled = false;
        void mapping.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            },
        );
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(started).toEqual([0, 1, 2]);
        expect(settled).toBe(false);
        releaseWorkers();
        await expect(mapping).rejects.toThrow('expected');
        expect(started).toEqual([0, 1, 2]);
    });

    it('releases semaphore capacity after success and failure', async () => {
        const semaphore = new AsyncSemaphore(2);
        const bounded = await verifyBounded((operation) => semaphore.run(operation));
        await expect(semaphore.run(() => Promise.reject(new Error('expected')))).rejects.toThrow(
            'expected',
        );

        expect(bounded.peak).toBe(2);
        await expect(semaphore.run(() => Promise.resolve('released'))).resolves.toBe('released');
    });
});
