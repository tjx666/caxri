import { describe, expect, it } from 'vitest';

import { FileOperationQueue } from '../operation-queue';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((complete) => {
        resolve = complete;
    });
    return { promise, resolve };
}

describe('FileOperationQueue', () => {
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
});
