import { describe, expect, it, vi } from 'vitest';

import { TerminalRestoreSupervisor } from '../restore-supervisor';

function retainedGenerationCount(supervisor: TerminalRestoreSupervisor): number {
    return (
        supervisor as unknown as {
            generations: Map<string, number>;
        }
    ).generations.size;
}

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

        let isCurrentStarted = false;
        const currentSession = supervisor.restore('session-b', [
            () => {
                isCurrentStarted = true;
                return Promise.resolve(true);
            },
        ]);

        await vi.waitFor(() => expect(isCurrentStarted).toBe(true));
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

    it('retains a permanent-delete fence only until pending restore work settles', async () => {
        const supervisor = new TerminalRestoreSupervisor(2);
        const oldRestoreStarted = Promise.withResolvers<void>();
        const releaseOldRestore = Promise.withResolvers<void>();
        const oldRestore = supervisor.restore('session-reused', [
            async (isCurrent) => {
                oldRestoreStarted.resolve();
                await releaseOldRestore.promise;
                return isCurrent();
            },
        ]);
        await oldRestoreStarted.promise;

        supervisor.forget('session-reused');
        expect(retainedGenerationCount(supervisor)).toBe(1);

        await expect(
            supervisor.restore('session-reused', [() => Promise.resolve(true)]),
        ).resolves.toEqual([true]);
        releaseOldRestore.resolve();

        await expect(oldRestore).resolves.toEqual([false]);
        expect(retainedGenerationCount(supervisor)).toBe(0);
    });

    it('skips semaphore work queued before a Session is permanently forgotten', async () => {
        const supervisor = new TerminalRestoreSupervisor(1);
        const firstStarted = Promise.withResolvers<void>();
        const releaseFirst = Promise.withResolvers<void>();
        let queuedStarts = 0;
        const restoring = supervisor.restore('session-deleted', [
            async (isCurrent) => {
                firstStarted.resolve();
                await releaseFirst.promise;
                return isCurrent();
            },
            () => {
                queuedStarts += 1;
                return Promise.resolve(true);
            },
        ]);
        await firstStarted.promise;

        supervisor.forget('session-deleted');
        releaseFirst.resolve();

        await expect(restoring).resolves.toEqual([false, false]);
        expect(queuedStarts).toBe(0);
        expect(retainedGenerationCount(supervisor)).toBe(0);
    });

    it('does not retain generations for empty restores and permanently forgotten Sessions', async () => {
        const supervisor = new TerminalRestoreSupervisor();
        await Promise.all(
            Array.from({ length: 1_000 }, async (_, index) => {
                const sessionId = `session-${index}`;
                await supervisor.restore(sessionId, []);
                supervisor.forget(sessionId);
            }),
        );
        supervisor.cancel('session-never-restored');

        expect(retainedGenerationCount(supervisor)).toBe(0);
    });

    it('releases generation state after a failed restore', async () => {
        const supervisor = new TerminalRestoreSupervisor();

        await expect(
            supervisor.restore('session-failed', [() => Promise.reject(new Error('failed'))]),
        ).rejects.toThrow('failed');

        expect(retainedGenerationCount(supervisor)).toBe(0);
    });

    it('settles only after a restore that already started has finished, even when cancelled', async () => {
        const supervisor = new TerminalRestoreSupervisor(1);
        await expect(supervisor.settled('session-a')).resolves.toBeUndefined();
        const spawning = Promise.withResolvers<boolean>();
        let hasStarted = false;
        const restore = supervisor.restore('session-a', [
            () => {
                hasStarted = true;
                return spawning.promise;
            },
        ]);
        await vi.waitFor(() => expect(hasStarted).toBe(true));

        supervisor.cancel('session-a');
        let hasSettled = false;
        const settled = (async () => {
            await supervisor.settled('session-a');
            hasSettled = true;
        })();
        await Promise.resolve();
        expect(hasSettled).toBe(false);

        spawning.resolve(true);
        await settled;
        expect(hasSettled).toBe(true);
        await expect(restore).resolves.toEqual([true]);
        await expect(supervisor.settled('session-a')).resolves.toBeUndefined();
    });

    it('allows an archived Session to restore again after cancellation', async () => {
        const supervisor = new TerminalRestoreSupervisor(1);
        const restoreStarted = Promise.withResolvers<void>();
        const releaseRestore = Promise.withResolvers<void>();
        const archivedRestore = supervisor.restore('session-archived', [
            async (isCurrent) => {
                restoreStarted.resolve();
                await releaseRestore.promise;
                return isCurrent();
            },
        ]);
        await restoreStarted.promise;

        supervisor.cancel('session-archived');
        releaseRestore.resolve();

        await expect(archivedRestore).resolves.toEqual([false]);
        await expect(
            supervisor.restore('session-archived', [() => Promise.resolve(true)]),
        ).resolves.toEqual([true]);
        expect(retainedGenerationCount(supervisor)).toBe(0);
    });

    it('fences every pending restore without closing, so a later selection restores again', async () => {
        const supervisor = new TerminalRestoreSupervisor(1);
        const restoreStarted = Promise.withResolvers<void>();
        const releaseRestore = Promise.withResolvers<void>();
        let queuedStarts = 0;
        const pending = supervisor.restore('session-a', [
            async (isCurrent) => {
                restoreStarted.resolve();
                await releaseRestore.promise;
                return isCurrent();
            },
            () => {
                queuedStarts += 1;
                return Promise.resolve(true);
            },
        ]);
        await restoreStarted.promise;

        supervisor.cancelAll();
        releaseRestore.resolve();

        await expect(pending).resolves.toEqual([false, false]);
        expect(queuedStarts).toBe(0);
        await expect(
            supervisor.restore('session-b', [() => Promise.resolve(true)]),
        ).resolves.toEqual([true]);
        expect(retainedGenerationCount(supervisor)).toBe(0);
    });
});
