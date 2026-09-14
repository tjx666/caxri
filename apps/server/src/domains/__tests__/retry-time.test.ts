import { describe, expect, it } from 'vitest';

import { retryTimeLabel } from '../retry-time';

const now = Date.UTC(2026, 8, 14, 10, 0);

describe('retryTimeLabel', () => {
    /**
     * The host time zone is deliberately not pinned by the function, so the assertion is on the shape a sentence can
     * splice in. A locale leaking through from the environment would render 24-hour time and fail this.
     */
    it('names the deadline on a 12-hour English clock', () => {
        expect(retryTimeLabel(now + 35 * 60_000, now)).toMatch(/^\d{1,2}:\d{2} [AP]M$/);
    });

    it('reads the deadline rather than the current time', () => {
        expect(retryTimeLabel(now + 60 * 60_000, now)).not.toBe(
            retryTimeLabel(now + 120 * 60_000, now),
        );
    });

    /**
     * A Project Status snapshot is cached for minutes and outlives its own pause, so composing "retries after 6:35 PM"
     * at 6:36 would promise a time that has already gone by. The caller falls back to its generic sentence instead.
     */
    it('refuses a deadline that has already passed', () => {
        expect(retryTimeLabel(now - 1, now)).toBeUndefined();
        expect(retryTimeLabel(now, now)).toBeUndefined();
    });

    it('has nothing to say without a deadline', () => {
        expect(retryTimeLabel(undefined, now)).toBeUndefined();
    });

    it('rejects a deadline that is not a finite instant', () => {
        expect(retryTimeLabel(NaN, now)).toBeUndefined();
        expect(retryTimeLabel(Infinity, now)).toBeUndefined();
    });
});
