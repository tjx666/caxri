import { describe, expect, it, vi } from 'vitest';

import { createExtensionHostProcessLifecycle } from '../process-lifecycle';

describe('Extension Host process lifecycle', () => {
    it('stops the owned process when Server Core disconnects', () => {
        const disposeExtensions = vi.fn();
        const exit = vi.fn();
        const publish = vi.fn();
        const stopSampler = vi.fn();
        const lifecycle = createExtensionHostProcessLifecycle({
            disposeExtensions,
            exit,
            publish,
            schedule: vi.fn(),
            stopSampler,
        });

        lifecycle.stopAfterParentDisconnect();

        expect(stopSampler).toHaveBeenCalledOnce();
        expect(disposeExtensions).toHaveBeenCalledOnce();
        expect(publish.mock.calls).toEqual([['stopping'], ['stopped']]);
        expect(exit).toHaveBeenCalledWith(0);
    });

    it('makes requested shutdown and parent disconnect idempotent', () => {
        const scheduled: Array<() => void> = [];
        const disposeExtensions = vi.fn();
        const exit = vi.fn();
        const publish = vi.fn();
        const stopSampler = vi.fn();
        const lifecycle = createExtensionHostProcessLifecycle({
            disposeExtensions,
            exit,
            publish,
            schedule: (callback) => scheduled.push(callback),
            stopSampler,
        });

        lifecycle.scheduleRequestedShutdown();
        lifecycle.stopAfterParentDisconnect();
        scheduled[0]?.();

        expect(stopSampler).toHaveBeenCalledOnce();
        expect(disposeExtensions).toHaveBeenCalledOnce();
        expect(publish.mock.calls).toEqual([['stopping'], ['stopped']]);
        expect(exit).toHaveBeenCalledOnce();
    });
});
