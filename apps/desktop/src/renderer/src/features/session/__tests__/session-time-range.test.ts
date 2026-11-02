import { describe, expect, it } from 'vitest';

import { sessionTimeRangeStart } from '../session-time-range';

describe('sessionTimeRangeStart', () => {
    const now = new Date(2026, 10, 2, 14, 30).getTime();

    it('opens no window for any time', () => {
        expect(sessionTimeRangeStart('all', now)).toBeUndefined();
    });

    it('starts at local midnight and counts today as the first calendar day', () => {
        expect(sessionTimeRangeStart('today', now)).toBe(new Date(2026, 10, 2).getTime());
        expect(sessionTimeRangeStart('last7Days', now)).toBe(new Date(2026, 9, 27).getTime());
        expect(sessionTimeRangeStart('last30Days', now)).toBe(new Date(2026, 9, 4).getTime());
        expect(sessionTimeRangeStart('last90Days', now)).toBe(new Date(2026, 7, 5).getTime());
    });

    it('stays the same value throughout one day', () => {
        const morning = new Date(2026, 10, 2, 0, 1).getTime();
        const night = new Date(2026, 10, 2, 23, 59).getTime();
        expect(sessionTimeRangeStart('last7Days', morning)).toBe(
            sessionTimeRangeStart('last7Days', night),
        );
    });
});
