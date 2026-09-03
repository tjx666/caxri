import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { installTerminationSignalHandlers } from '../termination-signal';

// eslint-disable-next-line unicorn/prefer-event-target -- Node's `process` exposes an EventEmitter surface for signals.
class FakeSignalTarget extends EventEmitter {}

function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
}

describe('installTerminationSignalHandlers', () => {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        it(`${signal} waits for host.shutdown before stopping while IPC is connected`, async () => {
            const target = new FakeSignalTarget();
            let resolveShutdown: (isRequested: boolean) => void = () => {};
            const waitForShutdownRequest = vi.fn(
                () => new Promise<boolean>((resolve) => (resolveShutdown = resolve)),
            );
            const stop = vi.fn(() => Promise.resolve());
            installTerminationSignalHandlers({
                target,
                isConnected: () => true,
                waitForShutdownRequest,
                stop,
                graceMs: 3_000,
            });

            target.emit(signal);
            await flushMicrotasks();
            expect(waitForShutdownRequest).toHaveBeenCalledWith(3_000);
            expect(stop).not.toHaveBeenCalled();

            resolveShutdown(true);
            await flushMicrotasks();
            expect(stop).toHaveBeenCalledWith(0);
        });
    }

    it('falls back to stop after the grace window elapses without a host.shutdown reply', async () => {
        vi.useFakeTimers();
        try {
            const target = new FakeSignalTarget();
            const waitForShutdownRequest = vi.fn(
                (timeoutMs: number) =>
                    new Promise<boolean>((resolve) => {
                        setTimeout(() => resolve(false), timeoutMs);
                    }),
            );
            const stop = vi.fn(() => Promise.resolve());
            installTerminationSignalHandlers({
                target,
                isConnected: () => true,
                waitForShutdownRequest,
                stop,
                graceMs: 3_000,
            });

            target.emit('SIGTERM');
            await vi.advanceTimersByTimeAsync(2_999);
            expect(stop).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(1);
            expect(stop).toHaveBeenCalledWith(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('skips the wait when the parent IPC channel is already gone', async () => {
        const target = new FakeSignalTarget();
        const waitForShutdownRequest = vi.fn(() => Promise.resolve(true));
        const stop = vi.fn(() => Promise.resolve());
        installTerminationSignalHandlers({
            target,
            isConnected: () => false,
            waitForShutdownRequest,
            stop,
        });

        target.emit('SIGTERM');
        await flushMicrotasks();
        expect(waitForShutdownRequest).not.toHaveBeenCalled();
        expect(stop).toHaveBeenCalledWith(0);
    });
});
