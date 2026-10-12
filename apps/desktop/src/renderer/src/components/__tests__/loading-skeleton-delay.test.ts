import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    LOADING_SKELETON_DELAY_MS,
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
