import { describe, expect, it, vi } from 'vitest';

import { SessionRenameQueue } from '../rename';

describe('SessionRenameQueue', () => {
    it('serializes the complete rename sequence for one Session', async () => {
        const queue = new SessionRenameQueue();
        const firstGate = Promise.withResolvers<void>();
        const order: string[] = [];

        const first = queue.run('session-1', async () => {
            order.push('first:start');
            await firstGate.promise;
            order.push('first:end');
            return 'first';
        });
        const secondOperation = vi.fn(() => {
            order.push('second');
            return Promise.resolve('second');
        });
        const second = queue.run('session-1', secondOperation);

        await vi.waitFor(() => expect(order).toEqual(['first:start']));
        expect(secondOperation).not.toHaveBeenCalled();
        firstGate.resolve();
        await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
        expect(order).toEqual(['first:start', 'first:end', 'second']);
    });

    it('lets another Session proceed and continues after a failed rename', async () => {
        const queue = new SessionRenameQueue();
        const blocked = Promise.withResolvers<void>();
        const first = queue.run('session-1', async () => {
            await blocked.promise;
            throw new Error('provider failed');
        });
        const independent = queue.run('session-2', () => Promise.resolve('independent'));
        const recovered = queue.run('session-1', () => Promise.resolve('recovered'));

        await expect(independent).resolves.toBe('independent');
        blocked.resolve();
        await expect(first).rejects.toThrow('provider failed');
        await expect(recovered).resolves.toBe('recovered');
    });
});
