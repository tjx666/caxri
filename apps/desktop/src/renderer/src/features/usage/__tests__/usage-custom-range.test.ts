import { describe, expect, it } from 'vitest';

import {
    draftSpan,
    monthWeeks,
    parseUsageCustomRange,
    pickRangeDay,
    shiftMonth,
} from '../usage-custom-range';

describe('parseUsageCustomRange', () => {
    it('accepts ordered local days and rejects anything else', () => {
        expect(parseUsageCustomRange({ start: '2026-10-25', end: '2026-10-27' })).toEqual({
            start: '2026-10-25',
            end: '2026-10-27',
        });
        expect(parseUsageCustomRange({ start: '2026-10-27', end: '2026-10-25' })).toBeUndefined();
        expect(parseUsageCustomRange({ start: '10/25', end: '2026-10-27' })).toBeUndefined();
        expect(parseUsageCustomRange(undefined)).toBeUndefined();
    });
});

describe('shiftMonth', () => {
    it('crosses year boundaries both ways', () => {
        expect(shiftMonth('2026-12', 1)).toBe('2027-01');
        expect(shiftMonth('2026-01', -1)).toBe('2025-12');
        expect(shiftMonth('2026-10', 0)).toBe('2026-10');
    });
});

describe('monthWeeks', () => {
    it('lays a month out in Sunday-first weeks padded with blanks', () => {
        // October 2026 starts on a Thursday and has 31 days.
        const weeks = monthWeeks('2026-10');
        expect(weeks).toHaveLength(5);
        expect(weeks[0]).toEqual([
            undefined,
            undefined,
            undefined,
            undefined,
            '2026-10-01',
            '2026-10-02',
            '2026-10-03',
        ]);
        expect(weeks.at(-1)).toEqual([
            '2026-10-25',
            '2026-10-26',
            '2026-10-27',
            '2026-10-28',
            '2026-10-29',
            '2026-10-30',
            '2026-10-31',
        ]);
        expect(weeks.every((week) => week.length === 7)).toBe(true);
    });
});

describe('pickRangeDay', () => {
    it('starts on the first click and completes in date order on the second', () => {
        const first = pickRangeDay(undefined, '2026-10-27');
        expect(first).toEqual({ start: '2026-10-27', end: undefined });
        expect(pickRangeDay(first, '2026-10-25')).toEqual({
            start: '2026-10-25',
            end: '2026-10-27',
        });
        expect(pickRangeDay(first, '2026-10-27')).toEqual({
            start: '2026-10-27',
            end: '2026-10-27',
        });
    });

    it('starts over after a completed range', () => {
        expect(pickRangeDay({ start: '2026-10-01', end: '2026-10-05' }, '2026-10-20')).toEqual({
            start: '2026-10-20',
            end: undefined,
        });
    });
});

describe('draftSpan', () => {
    it('previews the span to the hovered day while the end is pending', () => {
        const draft = { start: '2026-10-25', end: undefined };
        expect(draftSpan(draft, '2026-10-20')).toEqual({ start: '2026-10-20', end: '2026-10-25' });
        expect(draftSpan(draft, undefined)).toEqual({ start: '2026-10-25', end: '2026-10-25' });
        expect(draftSpan({ start: '2026-10-01', end: '2026-10-05' }, '2026-10-20')).toEqual({
            start: '2026-10-01',
            end: '2026-10-05',
        });
        expect(draftSpan(undefined, '2026-10-20')).toBeUndefined();
    });
});
