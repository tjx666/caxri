import { describe, expect, it, vi } from 'vitest';

import { TerminalRestoreSupervisor } from '../terminal-restore-supervisor';

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
});
