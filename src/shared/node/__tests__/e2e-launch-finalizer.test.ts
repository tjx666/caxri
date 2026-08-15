import { describe, expect, it, vi } from 'vitest';

import { createE2ELaunchFinalizer } from '../e2e-launch-finalizer';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    return Promise.withResolvers<void>();
}

describe('E2E launch finalizer', () => {
    it('closes an open app and waits for its async lease cleanup before finishing', async () => {
        const cleanup = deferred();
        const cleanupTask = vi.fn(() => cleanup.promise);
        const finalizer = createE2ELaunchFinalizer(cleanupTask);
        const close = vi.fn(async () => {
            await finalizer.begin();
        });

        let isFinished = false;
        const finishing = (async () => {
            await finalizer.finish(close);
            isFinished = true;
        })();
        await Promise.resolve();

        expect(close).toHaveBeenCalledOnce();
        expect(cleanupTask).toHaveBeenCalledOnce();
        expect(isFinished).toBe(false);

        cleanup.resolve();
        await finishing;
        expect(isFinished).toBe(true);
    });

    it('does not close or release twice when the app already emitted close', async () => {
        const cleanupTask = vi.fn(() => Promise.resolve());
        const finalizer = createE2ELaunchFinalizer(cleanupTask);
        await finalizer.begin();
        const close = vi.fn(() => Promise.resolve());

        await finalizer.finish(close);

        expect(close).not.toHaveBeenCalled();
        expect(cleanupTask).toHaveBeenCalledOnce();
    });

    it('releases the lease when closing the app rejects before emitting close', async () => {
        const cleanupTask = vi.fn(() => Promise.resolve());
        const finalizer = createE2ELaunchFinalizer(cleanupTask);
        const closeError = new Error('Electron transport disconnected');

        await expect(finalizer.finish(() => Promise.reject(closeError))).rejects.toBe(closeError);

        expect(cleanupTask).toHaveBeenCalledOnce();
    });
});
