import { afterEach, describe, expect, it, vi } from 'vitest';

import { CoalescedScheduler } from '../coalesced-scheduler';

afterEach(() => {
    vi.useRealTimers();
});

describe('CoalescedScheduler', () => {
    it('turns a burst of high-frequency activity into one delayed refresh', async () => {
        vi.useFakeTimers();
        const run = vi.fn();
        const scheduler = new CoalescedScheduler(2_000, run);

        for (let index = 0; index < 1_000; index += 1) scheduler.schedule('terminal-1');
        await vi.advanceTimersByTimeAsync(1_999);
        expect(run).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(run).toHaveBeenCalledOnce();
        expect(run).toHaveBeenCalledWith('terminal-1');
    });

    it('cancels pending work when a Terminal closes', async () => {
        vi.useFakeTimers();
        const run = vi.fn();
        const scheduler = new CoalescedScheduler(2_000, run);

        scheduler.schedule('terminal-1');
        scheduler.cancel('terminal-1');
        await vi.runAllTimersAsync();

        expect(run).not.toHaveBeenCalled();
    });
});
