import { describe, expect, it, vi } from 'vitest';

import { TerminalRestoreSupervisor } from '../restore-supervisor';

describe('TerminalRestoreSupervisor', () => {
    it('bounds active restores and skips queued work from stale Session generations', async () => {
        const supervisor = new TerminalRestoreSupervisor(2);
        const firstWave = Promise.withResolvers<void>();
        let active = 0;
        let peak = 0;
        let firstSessionStarts = 0;
        let secondSessionStarts = 0;

        const firstSession = supervisor.restore(
            'session-a',
            Array.from({ length: 6 }, () => async () => {
                firstSessionStarts += 1;
                active += 1;
                peak = Math.max(peak, active);
                await firstWave.promise;
                active -= 1;
                return true;
            }),
        );

        await vi.waitFor(() => expect(firstSessionStarts).toBe(2));
        const secondSession = supervisor.restore('session-b', [
            () => {
                secondSessionStarts += 1;
                active += 1;
                peak = Math.max(peak, active);
                active -= 1;
                return Promise.resolve(true);
            },
        ]);
        firstWave.resolve();

        expect(await firstSession).toEqual([true, true, false, false, false, false]);
        expect(await secondSession).toEqual([true]);
        expect(firstSessionStarts).toBe(2);
        expect(secondSessionStarts).toBe(1);
        expect(peak).toBe(2);
    });

    it('releases stale restore slots immediately when the active Session changes', async () => {
        const supervisor = new TerminalRestoreSupervisor(4);
        const staleWaveStarted = Promise.withResolvers<void>();
        let staleStarts = 0;
        const staleSession = supervisor.restore(
            'session-a',
            Array.from({ length: 4 }, () => async (_isCurrent, signal) => {
                staleStarts += 1;
                if (staleStarts === 4) staleWaveStarted.resolve();
                await new Promise<void>((resolve) => {
                    if (signal.aborted) resolve();
                    else signal.addEventListener('abort', () => resolve(), { once: true });
                });
                return false;
            }),
        );
        await staleWaveStarted.promise;

        let currentStarted = false;
        const currentSession = supervisor.restore('session-b', [
            () => {
                currentStarted = true;
                return Promise.resolve(true);
            },
        ]);

        await vi.waitFor(() => expect(currentStarted).toBe(true));
        expect(await staleSession).toEqual([false, false, false, false]);
        expect(await currentSession).toEqual([true]);
    });

    it('keeps an active restore current when the same Session is selected again', async () => {
        const supervisor = new TerminalRestoreSupervisor(1);
        const restoreStarted = Promise.withResolvers<void>();
        const releaseRestore = Promise.withResolvers<void>();

        const activeRestore = supervisor.restore('session-a', [
            async (isCurrent, signal) => {
                restoreStarted.resolve();
                await releaseRestore.promise;
                return isCurrent() && !signal.aborted;
            },
        ]);
        await restoreStarted.promise;

        await expect(supervisor.restore('session-a', [])).resolves.toEqual([]);
        releaseRestore.resolve();

        await expect(activeRestore).resolves.toEqual([true]);
    });

    it('cancels active restore work when the newly selected Session has nothing to restore', async () => {
        const supervisor = new TerminalRestoreSupervisor(1);
        const restoreStarted = Promise.withResolvers<void>();
        const staleSession = supervisor.restore('session-a', [
            async (_isCurrent, signal) => {
                restoreStarted.resolve();
                await new Promise<void>((resolve) =>
                    signal.addEventListener('abort', () => resolve(), { once: true }),
                );
                return false;
            },
        ]);
        await restoreStarted.promise;

        expect(await supervisor.restore('session-b', [])).toEqual([]);
        expect(await staleSession).toEqual([false]);
    });
});
