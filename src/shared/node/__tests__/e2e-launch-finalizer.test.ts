import { describe, expect, it, vi } from 'vitest';

import { createE2ELaunchFinalizer } from '../e2e-launch-finalizer';

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((resolvePromise) => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

describe('E2E launch finalizer', () => {
    it('closes an open app and waits for its async lease cleanup before finishing', async () => {
        const cleanup = deferred();
        const cleanupTask = vi.fn(() => cleanup.promise);
        const finalizer = createE2ELaunchFinalizer(cleanupTask);
        const close = vi.fn(() => {
            void finalizer.begin();
            return Promise.resolve();
        });

        let finished = false;
        const finishing = finalizer.finish(close).then(() => {
            finished = true;
        });
        await Promise.resolve();

        expect(close).toHaveBeenCalledOnce();
        expect(cleanupTask).toHaveBeenCalledOnce();
        expect(finished).toBe(false);

        cleanup.resolve();
        await finishing;
        expect(finished).toBe(true);
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
