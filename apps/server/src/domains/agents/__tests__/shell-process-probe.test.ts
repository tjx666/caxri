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
            logger: { write: vi.fn() },
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

    it.each([
        { label: 'an unknown command', origin: 'input' as const, provider: undefined },
        { label: 'a hook-opened candidate', origin: 'hook' as const, provider: 'claude' as const },
    ])('keeps the fast-retry cap for $label', async ({ origin, provider }) => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const candidate: ShellPromotionCandidate = {
            attempts: 0,
            expiresAt: Number.MAX_SAFE_INTEGER,
            nextProcessProbeAt: 0,
            origin,
            processProbes: 0,
            provider,
            startedAt: Date.now(),
        };
        const detect = vi.fn(() => Promise.resolve(undefined));
        const exhausted = vi.fn();
        const probe = new ShellProcessProbe({
            detect,
            intervalMs: 5,
            isCurrent: () => true,
            isWatchCurrent: () => false,
            onConfirmed: vi.fn(() => true),
            logger: { write: vi.fn() },
            onExhausted: exhausted,
            onInactive: vi.fn(),
        });
        try {
            probe.observe('terminal', 42, candidate);
            await vi.advanceTimersByTimeAsync(20);
            expect(detect).toHaveBeenCalledTimes(5);
            expect(exhausted).not.toHaveBeenCalled();
            await vi.advanceTimersByTimeAsync(5);
            expect(exhausted).toHaveBeenCalledWith('terminal', candidate);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(detect).toHaveBeenCalledTimes(5);
        } finally {
            probe.close();
        }
    });

    it('backs off a direct Agent command after its fast retries and stops at the total cap', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
        const startedAt = Date.now();
        const candidate: ShellPromotionCandidate = {
            attempts: 0,
            expiresAt: Number.MAX_SAFE_INTEGER,
            nextProcessProbeAt: 0,
            origin: 'input',
            processProbes: 0,
            provider: 'claude',
            startedAt,
        };
        const probeTimes: number[] = [];
        const detect = vi.fn(() => {
            probeTimes.push(Date.now() - startedAt);
            return Promise.resolve(undefined);
        });
        const exhausted = vi.fn();
        const probe = new ShellProcessProbe({
            detect,
            intervalMs: 5,
            isCurrent: () => true,
            isWatchCurrent: () => false,
            onConfirmed: vi.fn(() => true),
            logger: { write: vi.fn() },
            onExhausted: exhausted,
            onInactive: vi.fn(),
        });
        try {
            probe.observe('terminal', 42, candidate);
            await vi.advanceTimersByTimeAsync(1_000);
            probe.observe('terminal', 42, candidate);
            expect(probeTimes).toEqual([0, 5, 10, 15, 20, 30, 50, 90, 130, 170]);
            expect(exhausted).toHaveBeenCalledWith('terminal', candidate);
        } finally {
            probe.close();
        }
    });
});
