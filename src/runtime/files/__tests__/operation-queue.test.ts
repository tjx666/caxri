import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileOperationQueue } from '../operation-queue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

describe('FileOperationQueue', () => {
    afterEach(() => vi.useRealTimers());

    it('serializes operations and rejects work beyond its bounded wait list', async () => {
        const queue = new FileOperationQueue(2);
        const firstRelease = deferred();
        const events: string[] = [];

        const first = queue.run(async () => {
            events.push('first:start');
            await firstRelease.promise;
            events.push('first:end');
        });
        const second = queue.run(() => {
            events.push('second');
            return Promise.resolve();
        });

        await expect(queue.run(() => Promise.resolve(undefined))).rejects.toMatchObject({
            code: 'CAPACITY',
        });
        expect(events).toEqual(['first:start']);

        firstRelease.resolve();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second']);
    });

    it('cancels waiting work before it can run after reporting a timeout', async () => {
        vi.useFakeTimers();
        const queue = new FileOperationQueue(2);
        const firstRelease = deferred();
        let timedOutError: unknown;
        let timedOutOperationRan = false;

        const first = queue.run(() => firstRelease.promise);
        const timedOut = queue
            .run(
                () => {
                    timedOutOperationRan = true;
                    return Promise.resolve();
                },
                { maximumWaitMs: 10 },
            )
            .catch((error: unknown) => {
                timedOutError = error;
            });

        await vi.advanceTimersByTimeAsync(10);
        firstRelease.resolve();
        await Promise.all([first, timedOut]);

        expect(timedOutError).toMatchObject({ code: 'TIMEOUT' });
        expect(timedOutOperationRan).toBe(false);
    });
});
