import type { UsageDay } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    activityHighlights,
    buildCumulative,
    buildHeatmap,
    buildUsageInsights,
    burnRateCaption,
    canOpenUsageSession,
    computeStreaks,
    didUsageRefreshFail,
    HEATMAP_WEEKS,
    peakHour,
    usageEmptyState,
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

describe('usageEmptyState', () => {
    const report = (agentSessions: number, tokens: number) => ({
        coverage: { agentSessions },
        totals: { tokens: { total: tokens } },
    });

    it('names the filtered Agent when it used nothing in the range', () => {
        expect(usageEmptyState(report(3, 0), 'claude')).toEqual({
            kind: 'agentFilter',
            title: 'No Claude usage in this range',
        });
        expect(usageEmptyState(report(0, 0), 'claude')).toMatchObject({
            kind: 'agentFilter',
        });
    });

    it('reports no usage at all only without a filter', () => {
        expect(usageEmptyState(report(0, 0), undefined)).toEqual({ kind: 'noUsage' });
        expect(usageEmptyState(report(3, 0), undefined)).toBeUndefined();
        expect(usageEmptyState(report(3, 10), 'claude')).toBeUndefined();
    });
});

describe('usage page captions', () => {
    it('flags a failed refresh only while an earlier report is still shown', () => {
        expect(didUsageRefreshFail({ data: {}, isError: true })).toBe(true);
        expect(didUsageRefreshFail({ data: undefined, isError: true })).toBe(false);
        expect(didUsageRefreshFail({ data: {}, isError: false })).toBe(false);
    });

    it('labels the burn-rate pace as an API-price estimate over its fixed window', () => {
        expect(burnRateCaption(30)).toBe('Last 30 days · est. $30.40/month at API prices');
    });

    it('opens only Sessions that still exist in the PrimarySidebar', () => {
        expect(canOpenUsageSession({ isArchived: false, isDeleted: false })).toBe(true);
        expect(canOpenUsageSession({ isArchived: true, isDeleted: false })).toBe(false);
        expect(canOpenUsageSession({ isArchived: false, isDeleted: true })).toBe(false);
    });
});

describe('buildUsageInsights', () => {
    const report = (activeMs: number) => ({
        activity: [day('2026-03-07', 2_000)],
        models: [],
        projects: [],
        totals: {
            activeMs,
            cacheSavingsUsd: 0,
            costUsd: 0,
            pullRequestsMerged: 0,
            tokens: { output: 2_000 },
        },
    });

    it('names the busiest day of the week without calling a weekend day a weekday', () => {
        expect(buildUsageInsights(report(0))).toContain(
            'Saturday is your busiest day of the week.',
        );
    });

    it('projects output per active hour only from at least a minute of Agent time', () => {
        const perHour = (activeMs: number) =>
            buildUsageInsights(report(activeMs)).find((insight) =>
                insight.includes('per active hour'),
            );
        expect(perHour(50)).toBeUndefined();
        expect(perHour(59_999)).toBeUndefined();
        expect(perHour(3_600_000)).toBe('Agents wrote 2k output tokens per active hour.');
    });
});
