import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProbeQueue } from '../probe-queue';

afterEach(() => {
    vi.useRealTimers();
});

describe('ProbeQueue', () => {
    it('runs one trailing probe for requests that arrive while a probe runs', async () => {
        const first = Promise.withResolvers<void>();
        const probeOnce = vi
            .fn<(terminalId: string) => Promise<void>>()
            .mockImplementationOnce(() => first.promise)
            .mockResolvedValue(undefined);
        const queue = new ProbeQueue(probeOnce);

        const leading = queue.probe('terminal-1');
        const joined = [queue.probe('terminal-1'), queue.probe('terminal-1')];
        first.resolve();
        await Promise.all([leading, ...joined]);

        expect(probeOnce).toHaveBeenCalledTimes(2);
    });

    it('waits for a running probe on close and refuses new ones', async () => {
        const running = Promise.withResolvers<void>();
        const events: string[] = [];
        const probeOnce = vi.fn(async () => {
            await running.promise;
            events.push('probe settled');
        });
        const queue = new ProbeQueue(probeOnce);

        const probing = queue.probe('terminal-1');
        const closing = (async () => {
            await queue.close();
            events.push('closed');
        })();
        await queue.probe('terminal-2');
        running.resolve();
        await Promise.all([probing, closing]);

        expect(events).toEqual(['probe settled', 'closed']);
        expect(probeOnce).toHaveBeenCalledOnce();
    });

    it('stops waiting for a probe that never settles', async () => {
        vi.useFakeTimers();
        const queue = new ProbeQueue(() => new Promise<never>(() => {}));

        const probing = queue.probe('terminal-1');
        const closing = queue.close();
        await vi.advanceTimersByTimeAsync(1000);

        await expect(closing).resolves.toBeUndefined();
        await expect(Promise.race([probing, Promise.resolve('pending')])).resolves.toBe('pending');
    });
});
