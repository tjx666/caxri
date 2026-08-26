import { describe, expect, it, vi } from 'vitest';

import { createExtensionHostProcessLifecycle } from '../process-lifecycle';

describe('Extension Host process lifecycle', () => {
    it('flushes the stopped manifest before exiting when Server Core disconnects', async () => {
        const order: string[] = [];
        const disposeExtensions = vi.fn();
        const exit = vi.fn((exitCode: number) => order.push(`exit:${exitCode}`));
        const flushManifest = vi.fn(() => {
            order.push('flush');
            return Promise.resolve();
        });
        const publish = vi.fn((state: string) => order.push(`publish:${state}`));
        const stopSampler = vi.fn();
        const lifecycle = createExtensionHostProcessLifecycle({
            disposeExtensions,
            exit,
            flushManifest,
            publish,
            schedule: vi.fn(),
            stopSampler,
        });

        await lifecycle.stopAfterParentDisconnect();

        expect(stopSampler).toHaveBeenCalledOnce();
        expect(disposeExtensions).toHaveBeenCalledOnce();
        expect(publish.mock.calls).toEqual([['stopping'], ['stopped']]);
        expect(flushManifest).toHaveBeenCalledOnce();
        expect(exit).toHaveBeenCalledWith(0);
        expect(order).toEqual(['publish:stopping', 'publish:stopped', 'flush', 'exit:0']);
    });

    it('makes requested shutdown and parent disconnect idempotent', async () => {
        const scheduled: Array<() => void> = [];
        const disposeExtensions = vi.fn();
        const exit = vi.fn();
        const flushManifest = vi.fn(() => Promise.resolve());
        const publish = vi.fn();
        const stopSampler = vi.fn();
        const lifecycle = createExtensionHostProcessLifecycle({
            disposeExtensions,
            exit,
            flushManifest,
            publish,
            schedule: (callback) => scheduled.push(callback),
            stopSampler,
        });

        lifecycle.scheduleRequestedShutdown();
        await lifecycle.stopAfterParentDisconnect();
        scheduled[0]?.();
        await Promise.resolve();

        expect(stopSampler).toHaveBeenCalledOnce();
        expect(disposeExtensions).toHaveBeenCalledOnce();
        expect(publish.mock.calls).toEqual([['stopping'], ['stopped']]);
        expect(flushManifest).toHaveBeenCalledOnce();
        expect(exit).toHaveBeenCalledOnce();
    });

    it('exits unsuccessfully after a private protocol violation', async () => {
        const exit = vi.fn();
        const lifecycle = createExtensionHostProcessLifecycle({
            disposeExtensions: vi.fn(),
            exit,
            flushManifest: () => Promise.resolve(),
            publish: vi.fn(),
            schedule: vi.fn(),
            stopSampler: vi.fn(),
        });

        await lifecycle.stopAfterProtocolViolation();

        expect(exit).toHaveBeenCalledWith(1);
    });
});
