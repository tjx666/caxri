import { describe, expect, it, vi } from 'vitest';

import { SessionSelectionQueue } from '../selection';

describe('SessionSelectionQueue', () => {
    it('commits rapid selections in invocation order even when the first validation is slow', async () => {
        const queue = new SessionSelectionQueue();
        const firstValidation = Promise.withResolvers<void>();
        const commits: string[] = [];

        const first = queue.run(async () => {
            await firstValidation.promise;
            commits.push('first');
        });
        const second = queue.run(() => {
            commits.push('second');
            return Promise.resolve();
        });

        await vi.waitFor(() => expect(commits).toEqual([]));
        firstValidation.resolve();
        await Promise.all([first, second]);

        expect(commits).toEqual(['first', 'second']);
    });

    it('continues with the next selection after an earlier validation fails', async () => {
        const queue = new SessionSelectionQueue();
        const first = queue.run(() => Promise.reject(new Error('invalid root')));
        const second = queue.run(() => Promise.resolve('selected'));

        await expect(first).rejects.toThrow('invalid root');
        await expect(second).resolves.toBe('selected');
    });
});
