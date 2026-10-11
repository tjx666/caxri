import type { UsageDay } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    activityHighlights,
    agentTimeDetail,
    buildCumulative,
    buildHeatmap,
    buildUsageInsights,
    burnRateCaption,
    canOpenUsageSession,
    computeStreaks,
    didUsageRefreshFail,
    HEATMAP_WEEKS,
    peakHour,
    usageCoverageNotes,
    usageDayTooltip,
    usageEmptyState,
    usageHourTooltip,
    usageScanCaption,
    usageSessionCount,
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

describe('usageDayTooltip and usageHourTooltip', () => {
    it('names the day or hour span with its figures, or says there was no usage', () => {
        expect(
            usageDayTooltip('2026-03-09', {
                date: '2026-03-09',
                tokens: 2_500_000,
                costUsd: 1.5,
                activeMs: 90 * 60_000,
            }),
        ).toBe('Mar 9, 2026 · 2.5M tokens · $1.50 · 1h 30m active');
        expect(usageDayTooltip('2026-03-08', day('2026-03-08', 0))).toBe('Mar 8, 2026 · No usage');
        expect(usageDayTooltip('2026-03-07', undefined)).toBe('Mar 7, 2026 · No usage');
        expect(usageHourTooltip(11, 12_300_000)).toBe('11:00–12:00 · 12.3M tokens');
        expect(usageHourTooltip(23, 0)).toBe('23:00–00:00 · No usage');
    });
});

describe('usageEmptyState', () => {
    const report = (
        agentSessions: number,
        tokens: number,
        outsideCaxri?: { agentSessions: number; pendingScans: number },
        pendingScans = 0,
    ) => ({
        coverage: { agentSessions, pendingScans, outsideCaxri },
        totals: { tokens: { total: tokens } },
    });

    it('waits for the first scan outside Caxri before calling the page empty', () => {
        const scanning = { agentSessions: 0, pendingScans: 40 };
        expect(usageEmptyState(report(0, 0, scanning), undefined)).toEqual({ kind: 'scanning' });
        expect(
            usageEmptyState(report(0, 5, { agentSessions: 1, pendingScans: 40 }), undefined),
        ).toBeUndefined();
        expect(
            usageEmptyState(report(0, 0, { agentSessions: 2, pendingScans: 0 }), undefined),
        ).toBeUndefined();
    });

    it('waits for the background ledger scan in the Caxri scope too', () => {
        expect(usageEmptyState(report(3, 0, undefined, 3), undefined)).toEqual({
            kind: 'scanning',
        });
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
        const row = { isArchived: false, isDeleted: false, isOutsideCaxri: false };
        expect(canOpenUsageSession(row)).toBe(true);
        expect(canOpenUsageSession({ ...row, isArchived: true })).toBe(false);
        expect(canOpenUsageSession({ ...row, isDeleted: true })).toBe(false);
        expect(canOpenUsageSession({ ...row, isOutsideCaxri: true })).toBe(false);
    });

    it('counts Agent Sessions outside Caxri beside the Sessions', () => {
        expect(agentTimeDetail({ sessionsWithUsage: 1, outsideSessionsWithUsage: 0 })).toBe(
            'Across 1 Session',
        );
        expect(agentTimeDetail({ sessionsWithUsage: 81, outsideSessionsWithUsage: 120 })).toBe(
            'Across 81 Sessions + 120 outside',
        );
    });

    it('counts conversations run outside Caxri as conversations, not Sessions', () => {
        expect(usageSessionCount(1, false)).toBe('1 Session');
        expect(usageSessionCount(3, false)).toBe('3 Sessions');
        expect(usageSessionCount(1, true)).toBe('1 conversation');
        expect(usageSessionCount(2819, true)).toBe('2819 conversations');
    });

    it('shows scan progress only while transcripts remain', () => {
        const coverage = (pendingScans: number, ledger = 0) => ({
            coverage: { pendingScans: ledger, outsideCaxri: { agentSessions: 0, pendingScans } },
        });
        expect(usageScanCaption(coverage(1_234))).toBe('Reading 1,234 more transcripts…');
        expect(usageScanCaption(coverage(1_234, 6))).toBe('Reading 1,240 more transcripts…');
        expect(usageScanCaption(coverage(0))).toBeUndefined();
        expect(usageScanCaption({ coverage: { pendingScans: 1 } })).toBe(
            'Reading 1 more transcript…',
        );
        expect(usageScanCaption({ coverage: { pendingScans: 0 } })).toBeUndefined();
    });

    it('says what the coverage counts for each scope', () => {
        const base = {
            pricing: { source: 'bundled' as const },
            coverage: {
                agentSessions: 2,
                unavailable: 0,
                pendingScans: 0,
                pendingPullRequests: 0,
                unpricedModels: [],
            },
        };
        expect(usageCoverageNotes({ ...base, scope: 'caxri' })[1]).toBe(
            'Counts 2 Agent conversations started in Caxri Sessions, including archived and deleted Sessions.',
        );
        expect(
            usageCoverageNotes({
                ...base,
                scope: 'all',
                coverage: { ...base.coverage, outsideCaxri: { agentSessions: 5, pendingScans: 0 } },
            })[1],
        ).toBe(
            'Counts 2 Agent conversations started in Caxri Sessions, including archived and deleted Sessions, plus 5 run outside Caxri on this Mac.',
        );
    });

    it('calls a transcript missing only once the scan has looked for it', () => {
        const coverage = (pendingScans: number) =>
            usageCoverageNotes({
                pricing: { source: 'bundled' },
                scope: 'caxri',
                coverage: {
                    agentSessions: 2,
                    unavailable: 1,
                    pendingScans,
                    pendingPullRequests: 0,
                    unpricedModels: [],
                },
            }).join(' ');
        expect(coverage(0)).toContain('1 conversation has no transcript on this machine');
        expect(coverage(2)).not.toContain('no transcript');
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
