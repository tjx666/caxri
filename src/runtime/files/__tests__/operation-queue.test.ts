import { afterEach, describe, expect, it, vi } from 'vitest';

import { FileOperationQueue } from '../operation-queue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    return Promise.withResolvers<void>();
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
        let isTimedOutOperationRan = false;

        const first = queue.run(() => firstRelease.promise);
        const timedOut = (async () => {
            try {
                await queue.run(
                    () => {
                        isTimedOutOperationRan = true;
                        return Promise.resolve();
                    },
                    { maximumWaitMs: 10 },
                );
            } catch (error) {
                timedOutError = error;
            }
        })();

        await vi.advanceTimersByTimeAsync(10);
        firstRelease.resolve();
        await Promise.all([first, timedOut]);

        expect(timedOutError).toMatchObject({ code: 'TIMEOUT' });
        expect(isTimedOutOperationRan).toBe(false);
    });

    it('allows unrelated paths to proceed while overlapping paths remain ordered', async () => {
        const queue = new FileOperationQueue(4);
        const firstRelease = deferred();
        const events: string[] = [];

        const first = queue.run(
            async () => {
                events.push('first:start');
                await firstRelease.promise;
                events.push('first:end');
            },
            { paths: ['/project/large-folder'] },
        );
        const overlapping = queue.run(
            () => {
                events.push('overlapping');
                return Promise.resolve();
            },
            { paths: ['/project/large-folder/nested.txt'] },
        );
        const unrelated = queue.run(
            () => {
                events.push('unrelated');
                return Promise.resolve();
            },
            { paths: ['/project/notes.txt'] },
        );

        await unrelated;
        expect(events).toEqual(['first:start', 'unrelated']);
        firstRelease.resolve();
        await Promise.all([first, overlapping]);
        expect(events).toEqual(['first:start', 'unrelated', 'first:end', 'overlapping']);
    });

    it('serializes operation groups even when their paths do not overlap', async () => {
        const queue = new FileOperationQueue(3);
        const firstRelease = deferred();
        const events: string[] = [];

        const first = queue.run(
            async () => {
                events.push('first:start');
                await firstRelease.promise;
                events.push('first:end');
            },
            { group: 'copy', paths: ['/project/one'] },
        );
        const second = queue.run(
            () => {
                events.push('second');
                return Promise.resolve();
            },
            { group: 'copy', paths: ['/project/two'] },
        );

        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(events).toEqual(['first:start']);
        firstRelease.resolve();
        await Promise.all([first, second]);
        expect(events).toEqual(['first:start', 'first:end', 'second']);
    });
});
