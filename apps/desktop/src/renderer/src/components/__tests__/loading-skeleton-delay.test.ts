import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    claimLoadingSkeletonClock,
    createLoadingSkeletonClock,
    LOADING_SKELETON_DELAY_MS,
    LOADING_SKELETON_HANDOFF_MS,
    releaseLoadingSkeletonClock,
    remainingLoadingSkeletonDelay,
    scheduleLoadingSkeletonReveal,
} from '../loading-skeleton-delay';

describe('scheduleLoadingSkeletonReveal', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('reveals the placeholder only after the delay', () => {
        const reveal = vi.fn();
        scheduleLoadingSkeletonReveal(reveal);

        vi.advanceTimersByTime(LOADING_SKELETON_DELAY_MS - 1);
        expect(reveal).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(reveal).toHaveBeenCalledOnce();
    });

    it('never reveals a placeholder that was cancelled first, as a fast load unmounts it', () => {
        const reveal = vi.fn();
        const cancel = scheduleLoadingSkeletonReveal(reveal);

        vi.advanceTimersByTime(LOADING_SKELETON_DELAY_MS / 2);
        cancel();
        vi.advanceTimersByTime(LOADING_SKELETON_DELAY_MS);
        expect(reveal).not.toHaveBeenCalled();
    });
});

describe('loading skeleton clock', () => {
    it('continues a wait handed over within the handoff window', () => {
        const clock = createLoadingSkeletonClock();
        expect(claimLoadingSkeletonClock(clock, 0)).toBe(0);
        releaseLoadingSkeletonClock(clock, 600);

        const startedAt = claimLoadingSkeletonClock(clock, 600 + LOADING_SKELETON_HANDOFF_MS);
        expect(startedAt).toBe(0);
        expect(remainingLoadingSkeletonDelay(startedAt, 600 + LOADING_SKELETON_HANDOFF_MS)).toBe(0);
    });

    it('starts a new wait after the handoff window', () => {
        const clock = createLoadingSkeletonClock();
        claimLoadingSkeletonClock(clock, 0);
        releaseLoadingSkeletonClock(clock, 100);

        const later = 100 + LOADING_SKELETON_HANDOFF_MS + 1;
        expect(claimLoadingSkeletonClock(clock, later)).toBe(later);
        expect(remainingLoadingSkeletonDelay(later, later)).toBe(LOADING_SKELETON_DELAY_MS);
    });

    it('shares the wait between placeholders mounted together', () => {
        const clock = createLoadingSkeletonClock();
        claimLoadingSkeletonClock(clock, 0);
        expect(claimLoadingSkeletonClock(clock, 5_000)).toBe(0);
        releaseLoadingSkeletonClock(clock, 5_001);
        expect(clock.endedAt).toBeUndefined();
    });
});
