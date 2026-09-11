import { afterEach, describe, expect, it, vi } from 'vitest';

import { ShellProcessProbe } from '../shell-process-probe';
import type { ShellPromotionCandidate } from '../shell-promotion';

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('ShellProcessProbe', () => {
    it('retains the retry when a timer wakes before the wall-clock deadline', async () => {
        vi.useFakeTimers();
        const now = vi.spyOn(Date, 'now').mockReturnValue(100);
        const candidate: ShellPromotionCandidate = {
            attempts: 0,
            expiresAt: 1_000,
            nextProcessProbeAt: 0,
            origin: 'input',
            processProbes: 0,
            startedAt: 100,
        };
        const detect = vi
            .fn<() => Promise<'claude' | undefined>>()
            .mockResolvedValueOnce(undefined)
            .mockResolvedValue('claude');
        const confirmed = vi.fn(() => true);
        const probe = new ShellProcessProbe({
            detect,
            intervalMs: 5,
            isCurrent: () => true,
            isWatchCurrent: () => false,
            onConfirmed: confirmed,
            onError: vi.fn(),
            onExhausted: vi.fn(),
            onInactive: vi.fn(),
        });
        try {
            probe.observe('terminal', 42, candidate);
            await vi.advanceTimersByTimeAsync(0);
            now.mockReturnValue(104);
            await vi.advanceTimersByTimeAsync(5);
            expect(detect).toHaveBeenCalledTimes(1);
            now.mockReturnValue(105);
            await vi.advanceTimersByTimeAsync(1);
            expect(confirmed).toHaveBeenCalledWith('terminal', 'claude', candidate);
        } finally {
            probe.close();
        }
    });
});
