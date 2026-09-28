import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    areLabelsEqual,
    nextTickedValue,
    RELATIVE_TIME_TICK_MS,
    subscribeToRelativeTimeClock,
} from './use-relative-time';

describe('Relative-time shared clock', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('notifies a later subscriber on the same tick when an earlier one throws', () => {
        vi.useFakeTimers();
        const failing = vi.fn(() => {
            throw new Error('relative time tick listener failure');
        });
        const surviving = vi.fn();
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const unsubscribeFailing = subscribeToRelativeTimeClock(failing);
        const unsubscribeSurviving = subscribeToRelativeTimeClock(surviving);

        vi.advanceTimersByTime(RELATIVE_TIME_TICK_MS);

        expect(failing).toHaveBeenCalledTimes(1);
        expect(surviving).toHaveBeenCalledTimes(1);
        unsubscribeFailing();
        unsubscribeSurviving();
    });
});

describe('Relative-time tick publication', () => {
    it('keeps the value already on screen when the new one means the same thing', () => {
        const previous = { value: ['3 hours ago'] };
        const published = nextTickedValue(previous, ['3 hours ago'], areLabelsEqual);
        // Identity, not deep equality: `useSyncExternalStore` re-renders on any new reference.
        expect(published).toBe(previous.value);
    });

    it('publishes the new value once the wording changes', () => {
        const next = ['4 hours ago'];
        expect(nextTickedValue({ value: ['3 hours ago'] }, next, areLabelsEqual)).toBe(next);
    });

    it('publishes the first value when nothing is on screen yet', () => {
        const next = ['just now'];
        expect(nextTickedValue(undefined, next, areLabelsEqual)).toBe(next);
    });

    it('keeps an unchanged single label', () => {
        const previous = { value: '3 hours ago' };
        expect(nextTickedValue(previous, '3 hours ago', Object.is)).toBe(previous.value);
    });

    it('treats a missing timestamp as a stable value of its own', () => {
        const previous = { value: undefined };
        expect(nextTickedValue<string | undefined>(previous, undefined, Object.is)).toBeUndefined();
        expect(nextTickedValue<string | undefined>(previous, 'just now', Object.is)).toBe(
            'just now',
        );
    });
});

describe('Relative-time label comparison', () => {
    it('matches lists that read the same at every position', () => {
        expect(areLabelsEqual(['a', undefined, 'b'], ['a', undefined, 'b'])).toBe(true);
    });

    it('separates lists that differ at one position', () => {
        expect(areLabelsEqual(['a', 'b'], ['a', 'c'])).toBe(false);
    });

    it('separates a list that gained a row from the one before it', () => {
        // A row added or removed changes the list even when every surviving label still reads the same.
        expect(areLabelsEqual(['a'], ['a', 'a'])).toBe(false);
    });

    it('separates a present label from a missing one', () => {
        expect(areLabelsEqual(['a'], [undefined])).toBe(false);
    });
});
