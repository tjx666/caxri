import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    PENDING_CHORD_TIMEOUT_MS,
    publishPendingChord,
    usePendingChordStore,
} from '../pending-chord-store';

describe('publishPendingChord', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        publishPendingChord(undefined, () => {});
        vi.useRealTimers();
    });

    it('shows the armed chord and clears it when the sequence ends', () => {
        publishPendingChord('cmd+k', () => {});
        expect(usePendingChordStore.getState().leadingChord).toBe('cmd+k');
        publishPendingChord(undefined, () => {});
        expect(usePendingChordStore.getState().leadingChord).toBeUndefined();
    });

    it('expires the dispatcher state and the hint together after the timeout', () => {
        const expire = vi.fn();
        publishPendingChord('cmd+k', expire);
        vi.advanceTimersByTime(PENDING_CHORD_TIMEOUT_MS - 1);
        expect(expire).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(expire).toHaveBeenCalledOnce();
        expect(usePendingChordStore.getState().leadingChord).toBeUndefined();
    });

    it('does not expire a sequence that completed first', () => {
        const expire = vi.fn();
        publishPendingChord('cmd+k', expire);
        publishPendingChord(undefined, expire);
        vi.advanceTimersByTime(PENDING_CHORD_TIMEOUT_MS * 2);
        expect(expire).not.toHaveBeenCalled();
    });
});
