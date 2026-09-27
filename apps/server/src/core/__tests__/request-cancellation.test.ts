import { describe, expect, it, vi } from 'vitest';

import { principalRequestKey, RequestCancellationRegistry } from '../request-cancellation';

describe('RequestCancellationRegistry', () => {
    it('includes the authenticated Desktop generation in request identity', () => {
        expect(
            principalRequestKey(
                {
                    capabilities: ['desktop'],
                    principal: { kind: 'desktop', id: 'desktop-1', generation: 4 },
                },
                'request-1',
            ),
        ).not.toBe(
            principalRequestKey(
                {
                    capabilities: ['desktop'],
                    principal: { kind: 'desktop', id: 'desktop-1', generation: 5 },
                },
                'request-1',
            ),
        );
    });

    it('cancels only the principal-and-generation-scoped request identity', async () => {
        const registry = new RequestCancellationRegistry();
        const aborted = Promise.withResolvers<void>();
        const pending = registry.run('desktop:one:g1:request-1', async (signal) => {
            await new Promise<void>((resolve) =>
                signal.addEventListener('abort', () => resolve(), { once: true }),
            );
            aborted.resolve();
            return 'cancelled';
        });

        expect(registry.cancel('desktop:one:g2:request-1')).toBe(true);
        expect(registry.cancel('desktop:one:g1:request-1')).toBe(true);
        await aborted.promise;
        await expect(pending).resolves.toBe('cancelled');
        expect(registry.cancel('desktop:one:g1:request-1')).toBe(true);
    });

    it('consumes an early cancellation before starting Runtime work', async () => {
        const registry = new RequestCancellationRegistry();
        const task = vi.fn(() => Promise.resolve('unexpected'));

        expect(registry.cancel('desktop:one:g1:request-1')).toBe(true);

        await expect(registry.run('desktop:one:g1:request-1', task)).rejects.toMatchObject({
            code: 'CANCELLED',
        });
        expect(task).not.toHaveBeenCalled();
    });

    it('aborts only a disconnectable request when its caller disconnects', async () => {
        const registry = new RequestCancellationRegistry();
        const untilAborted = (signal: AbortSignal) =>
            new Promise<string>((resolve) =>
                signal.addEventListener('abort', () => resolve('aborted'), { once: true }),
            );
        const mutation = Promise.withResolvers<string>();
        const mutating = registry.run('desktop:one:g1:mutation', async (signal) =>
            Promise.race([untilAborted(signal), mutation.promise]),
        );
        const waiting = registry.runDisconnectable('desktop:one:g1:wait', untilAborted);

        registry.disconnect('desktop:one:g1:mutation');
        registry.disconnect('desktop:one:g1:wait');
        mutation.resolve('finished');

        await expect(waiting).resolves.toBe('aborted');
        await expect(mutating).resolves.toBe('finished');
        // A disconnect for a request that is not running leaves no tombstone behind.
        registry.disconnect('desktop:one:g1:later');
        await expect(
            registry.run('desktop:one:g1:later', () => Promise.resolve('ran')),
        ).resolves.toBe('ran');
    });
});
