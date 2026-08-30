import { describe, expect, it, vi } from 'vitest';

import { closeE2EApp } from './desktop-lease-lifecycle';

describe('E2E desktop lease lifecycle', () => {
    it('returns ownership to the harness before closing Electron and cleaning Hosts', async () => {
        const order: string[] = [];
        const step = (name: string) =>
            vi.fn(() => {
                order.push(name);
                return Promise.resolve();
            });

        await closeE2EApp({
            applicationProcess: { exitCode: null, signalCode: null },
            cleanup: step('cleanup'),
            close: step('close'),
            handBackLease: step('hand-back'),
            prepareBeforeClose: step('prepare'),
            restoreBeforeClose: step('restore'),
        });

        expect(order).toEqual(['hand-back', 'restore', 'prepare', 'close', 'cleanup']);
    });

    it('skips handback and cleans Hosts after Electron has already exited', async () => {
        const close = vi.fn<() => Promise<void>>();
        const handBackLease = vi.fn(() => Promise.resolve());
        const cleanup = vi.fn(() => Promise.resolve());

        await closeE2EApp({
            applicationProcess: { exitCode: 0, signalCode: null },
            cleanup,
            close,
            handBackLease,
        });

        expect(handBackLease).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
        expect(cleanup).toHaveBeenCalledOnce();
    });

    it('still closes Electron and cleans Hosts when handback fails', async () => {
        const failure = new Error('handback failed');
        const close = vi.fn(() => Promise.resolve());
        const cleanup = vi.fn(() => Promise.resolve());

        await expect(
            closeE2EApp({
                applicationProcess: { exitCode: null, signalCode: null },
                cleanup,
                close,
                handBackLease: () => Promise.reject(failure),
            }),
        ).rejects.toBe(failure);
        expect(close).toHaveBeenCalledOnce();
        expect(cleanup).toHaveBeenCalledOnce();
    });
});
