import type { UsageDay } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    activityHighlights,
    buildCumulative,
    buildHeatmap,
    computeStreaks,
    HEATMAP_WEEKS,
    peakHour,
} from '../usage-metrics';

function day(date: string, tokens: number, costUsd = 0): UsageDay {
    return { date, tokens, costUsd, activeMs: 0 };
}

/**
 * A Tuesday.
 */
const TODAY = '2026-03-10';

describe('buildHeatmap', () => {
    it('ends on the week of today, starts each column on Sunday, and marks future days', () => {
        const weeks = buildHeatmap([day(TODAY, 5)], TODAY, 'tokens');

        expect(weeks).toHaveLength(HEATMAP_WEEKS);
        const last = weeks.at(-1)!;
        expect(last.start).toBe('2026-03-08');
        expect(last.cells.map((cell) => cell.isFuture)).toEqual([
            false,
            false,
            false,
            true,
            true,
            true,
            true,
        ]);
        expect(last.cells[2]).toMatchObject({ date: TODAY, value: 5, level: 4 });
        expect(weeks.filter((week) => week.monthLabel).length).toBeGreaterThanOrEqual(11);
    });

    it('assigns quartile levels so one outlier does not flatten the rest', () => {
        const activity = [
            day('2026-03-01', 1),
            day('2026-03-02', 2),
            day('2026-03-03', 3),
            day('2026-03-04', 1000),
        ];
        const cells = buildHeatmap(activity, TODAY, 'tokens').flatMap((week) => week.cells);
        const levelOf = (date: string) => cells.find((cell) => cell.date === date)?.level;

        expect(levelOf('2026-03-01')).toBe(1);
        expect(levelOf('2026-03-02')).toBe(2);
        expect(levelOf('2026-03-03')).toBe(3);
        expect(levelOf('2026-03-04')).toBe(4);
        expect(levelOf('2026-03-05')).toBe(0);
    });

    it('switches to cost', () => {
        const weeks = buildHeatmap([day(TODAY, 5, 1.5)], TODAY, 'cost');
        expect(weeks.at(-1)!.total).toBe(1.5);
    });
});

describe('buildCumulative', () => {
    it('accumulates through today and stops before future days', () => {
        const points = buildCumulative(
            buildHeatmap([day('2026-03-08', 2), day(TODAY, 3)], TODAY, 'tokens'),
        );

        expect(points.at(-1)).toEqual({ date: TODAY, total: 5 });
        expect(points.find((point) => point.date === '2026-03-09')?.total).toBe(2);
    });
});

describe('computeStreaks', () => {
    it('keeps the current streak alive through a quiet today', () => {
        const activity = [
            day('2026-03-01', 1),
            day('2026-03-02', 1),
            day('2026-03-03', 1),
            day('2026-03-08', 1),
            day('2026-03-09', 1),
        ];

        expect(computeStreaks(activity, TODAY)).toEqual({ current: 2, longest: 3 });
        expect(computeStreaks(activity, '2026-03-11')).toEqual({ current: 0, longest: 3 });
    });
});

describe('activityHighlights and peakHour', () => {
    it('finds the busiest day, weekday, and hour', () => {
        const highlights = activityHighlights([
            day('2026-03-08', 10),
            day('2026-03-09', 30),
            day(TODAY, 0),
        ]);

        expect(highlights).toMatchObject({ activeDays: 2, busiestWeekday: 1 });
        expect(highlights.busiestDay?.date).toBe('2026-03-09');
        expect(peakHour(Array.from({ length: 24 }, (_, hour) => (hour === 14 ? 9 : 1)))).toBe(14);
        expect(peakHour(Array.from({ length: 24 }, () => 0))).toBeUndefined();
    });
});
