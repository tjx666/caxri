import type { UsageDay } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    activityCardLabel,
    activityHighlights,
    agentTimeDetail,
    buildCumulative,
    buildHeatmap,
    burnRateCaption,
    canOpenUsageSession,
    computeStreaks,
    costTileDetail,
    countLabel,
    didUsageRefreshFail,
    hasUnpricedProviderModel,
    HEATMAP_WEEKS,
    isUsageUnpriced,
    limitWindowState,
    peakHour,
    topCaption,
    usageCostDisplay,
    usageDayTooltip,
    usageEmptyState,
    usageHourTooltip,
    usageLoadFailureReason,
    usageLoadFailureText,
    usageRangeLabel,
    usageScanCaption,
    usageSessionCount,
} from '../usage-metrics';
import { buildUsageInsights, usageCoverageNotes } from '../usage-notes';

function day(date: string, tokens: number, costUsd = 0): UsageDay {
    return { date, tokens, costUsd, activeMs: 0 };
}

/**
 * A Tuesday.
 */
const TODAY = '2026-03-10';

describe('buildHeatmap', () => {
    it('ends on the week of today, starts each column on Sunday, and marks future days', () => {
        const weeks = buildHeatmap(translate, [day(TODAY, 5)], TODAY, 'tokens');

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
        const cells = buildHeatmap(translate, activity, TODAY, 'tokens').flatMap(
            (week) => week.cells,
        );
        const levelOf = (date: string) => cells.find((cell) => cell.date === date)?.level;

        expect(levelOf('2026-03-01')).toBe(1);
        expect(levelOf('2026-03-02')).toBe(2);
        expect(levelOf('2026-03-03')).toBe(3);
        expect(levelOf('2026-03-04')).toBe(4);
        expect(levelOf('2026-03-05')).toBe(0);
    });

    it('switches to cost', () => {
        const weeks = buildHeatmap(translate, [day(TODAY, 5, 1.5)], TODAY, 'cost');
        expect(weeks.at(-1)!.total).toBe(1.5);
    });
});

describe('buildCumulative', () => {
    it('accumulates through today and stops before future days', () => {
        const points = buildCumulative(
            buildHeatmap(translate, [day('2026-03-08', 2), day(TODAY, 3)], TODAY, 'tokens'),
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
            usageDayTooltip(translate, '2026-03-09', {
                date: '2026-03-09',
                tokens: 2_500_000,
                costUsd: 1.5,
                activeMs: 90 * 60_000,
            }),
        ).toBe('Mar 9, 2026 · 2.5M tokens · $1.50 · 1h 30m active');
        expect(usageDayTooltip(translate, '2026-03-08', day('2026-03-08', 0))).toBe(
            'Mar 8, 2026 · No usage',
        );
        expect(usageDayTooltip(translate, '2026-03-07', undefined)).toBe('Mar 7, 2026 · No usage');
        expect(usageDayTooltip(translate, '2026-03-06', day('2026-03-06', 16_300))).toBe(
            'Mar 6, 2026 · 16.3k tokens · No price · 0m active',
        );
        expect(usageHourTooltip(translate, 11, 12_300_000)).toBe('11:00–12:00 · 12.3M tokens');
        expect(usageHourTooltip(translate, 23, 0)).toBe('23:00–00:00 · No usage');
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
        expect(usageEmptyState(translate, report(0, 0, scanning), undefined)).toEqual({
            kind: 'scanning',
        });
        expect(
            usageEmptyState(
                translate,
                report(0, 5, { agentSessions: 1, pendingScans: 40 }),
                undefined,
            ),
        ).toBeUndefined();
        expect(
            usageEmptyState(
                translate,
                report(0, 0, { agentSessions: 2, pendingScans: 0 }),
                undefined,
            ),
        ).toBeUndefined();
    });

    it('waits for the background ledger scan in the Caxri scope too', () => {
        expect(usageEmptyState(translate, report(3, 0, undefined, 3), undefined)).toEqual({
            kind: 'scanning',
        });
    });

    it('names the filtered Agent when it used nothing in the range', () => {
        expect(usageEmptyState(translate, report(3, 0), 'claude')).toEqual({
            kind: 'agentFilter',
            title: 'No Claude usage in this range',
        });
        expect(usageEmptyState(translate, report(0, 0), 'claude')).toMatchObject({
            kind: 'agentFilter',
        });
    });

    it('reports no usage at all only without a filter', () => {
        expect(usageEmptyState(translate, report(0, 0), undefined)).toEqual({ kind: 'noUsage' });
        expect(usageEmptyState(translate, report(3, 0), undefined)).toBeUndefined();
        expect(usageEmptyState(translate, report(3, 10), 'claude')).toBeUndefined();
    });
});

describe('usage page captions', () => {
    it('flags a failed refresh only while an earlier report is still shown', () => {
        expect(didUsageRefreshFail({ data: {}, isError: true })).toBe(true);
        expect(didUsageRefreshFail({ data: undefined, isError: true })).toBe(false);
        expect(didUsageRefreshFail({ data: {}, isError: false })).toBe(false);
    });

    it('labels the burn-rate pace as an API-price estimate over its fixed window', () => {
        expect(burnRateCaption(translate, 30)).toBe(
            'Last 30 days · est. $30.40/month at API prices',
        );
        expect(burnRateCaption(translate, 0, true)).toBe(
            'Last 30 days · no price for the models used',
        );
    });

    it('opens only Sessions that still exist in the PrimarySidebar', () => {
        const row = { isArchived: false, isDeleted: false, isOutsideCaxri: false };
        expect(canOpenUsageSession(row)).toBe(true);
        expect(canOpenUsageSession({ ...row, isArchived: true })).toBe(false);
        expect(canOpenUsageSession({ ...row, isDeleted: true })).toBe(false);
        expect(canOpenUsageSession({ ...row, isOutsideCaxri: true })).toBe(false);
    });

    it('counts Agent Sessions outside Caxri beside the Sessions', () => {
        expect(
            agentTimeDetail(translate, { sessionsWithUsage: 1, outsideSessionsWithUsage: 0 }),
        ).toBe('Across 1 Session');
        expect(
            agentTimeDetail(translate, { sessionsWithUsage: 81, outsideSessionsWithUsage: 120 }),
        ).toBe('Across 81 Sessions + 120 outside');
    });

    it('counts Agent Sessions run outside Caxri as conversations, not Sessions', () => {
        expect(usageSessionCount(translate, 1, false)).toBe('1 Session');
        expect(usageSessionCount(translate, 3, false)).toBe('3 Sessions');
        expect(usageSessionCount(translate, 1, true)).toBe('1 conversation');
        expect(usageSessionCount(translate, 2819, true)).toBe('2,819 conversations');
    });

    it('shows scan progress only while transcripts remain', () => {
        const coverage = (pendingScans: number, ledger = 0) => ({
            coverage: { pendingScans: ledger, outsideCaxri: { agentSessions: 0, pendingScans } },
        });
        expect(usageScanCaption(translate, coverage(1_234))).toBe(
            'Reading 1,234 more conversations…',
        );
        expect(usageScanCaption(translate, coverage(1_234, 6))).toBe(
            'Reading 1,240 more conversations…',
        );
        expect(usageScanCaption(translate, coverage(0))).toBeUndefined();
        expect(usageScanCaption(translate, { coverage: { pendingScans: 1 } })).toBe(
            'Reading 1 more conversation…',
        );
        expect(usageScanCaption(translate, { coverage: { pendingScans: 0 } })).toBeUndefined();
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
        expect(usageCoverageNotes(translate, { ...base, scope: 'caxri' })[1]).toBe(
            'Counts 2 conversations started in Caxri Sessions, including archived and deleted Sessions.',
        );
        expect(
            usageCoverageNotes(translate, {
                ...base,
                scope: 'all',
                coverage: { ...base.coverage, outsideCaxri: { agentSessions: 5, pendingScans: 0 } },
            })[1],
        ).toBe(
            'Counts 2 conversations started in Caxri Sessions, including archived and deleted Sessions, plus 5 run outside Caxri on this Mac.',
        );
    });

    it('calls a transcript missing only once the scan has looked for it', () => {
        const coverage = (pendingScans: number) =>
            usageCoverageNotes(translate, {
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
        expect(coverage(0)).toContain('1 conversation is no longer saved on this Mac');
        expect(coverage(2)).not.toContain('no longer saved');
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
        expect(buildUsageInsights(translate, report(0))).toContain(
            'Saturday is your busiest day of the week.',
        );
    });

    it('projects output per active hour only from at least a minute of Agent time', () => {
        const perHour = (activeMs: number) =>
            buildUsageInsights(translate, report(activeMs)).find((insight) =>
                insight.includes('per active hour'),
            );
        expect(perHour(50)).toBeUndefined();
        expect(perHour(59_999)).toBeUndefined();
        expect(perHour(3_600_000)).toBe('Agents wrote 2k output tokens per active hour.');
    });
});

describe('heatmap month labels', () => {
    it('does not print the current month at both ends of the year', () => {
        const today = '2026-10-14';
        const weeks = buildHeatmap(translate, [], today, 'tokens');
        const labels = weeks.map((week) => week.monthLabel).filter(Boolean);
        expect(labels.filter((label) => label === 'Oct')).toHaveLength(1);
        expect(labels.at(-1)).toBe('Oct');
    });
});

describe('Usage page wording helpers', () => {
    it('pluralizes counts and captions truncated lists', () => {
        expect(countLabel(translate, 1, 'pullRequest')).toBe('1 pull request');
        expect(countLabel(translate, 3, 'mergedPullRequest')).toBe('3 merged pull requests');
        expect(topCaption(translate, 12, 40)).toBe('Top 12 of 40');
        expect(topCaption(translate, 12, 12)).toBeUndefined();
    });

    it('names the picked range and the metric the Activity card is drawn in', () => {
        expect(usageRangeLabel(translate, '7d', undefined)).toBe('Last 7 days');
        expect(usageRangeLabel(translate, 'all', undefined)).toBe('All time');
        expect(usageRangeLabel(translate, 'today', undefined)).toBe('Today');
        expect(
            usageRangeLabel(translate, 'custom', { start: '2026-10-25', end: '2026-10-27' }),
        ).toBe('Oct 25, 2026 to Oct 27, 2026');
        expect(
            usageRangeLabel(translate, 'custom', { start: '2026-10-25', end: '2026-10-25' }),
        ).toBe('Oct 25, 2026');
        expect(activityCardLabel(translate, 'tokens')).toBe('Token activity');
        expect(activityCardLabel(translate, 'cost')).toBe('Cost activity');
    });
});

describe('plan limit windows', () => {
    it('counts down to a reset', () => {
        expect(limitWindowState({ windowMinutes: 300, usedPercent: 40 }, 0, translate)).toEqual({
            kind: 'active',
        });
        expect(
            limitWindowState(
                { windowMinutes: 300, usedPercent: 40, resetsAt: 90 * 60_000 },
                0,
                translate,
            ),
        ).toEqual({ kind: 'active', resetLabel: 'resets in 1h 30m' });
        expect(
            limitWindowState(
                { windowMinutes: 10_080, usedPercent: 40, resetsAt: 50 * 3_600_000 },
                0,
                translate,
            ),
        ).toEqual({ kind: 'active', resetLabel: 'resets in 2d 2h' });
    });

    it('reports a window whose reset has passed as reset instead of "resets now"', () => {
        expect(
            limitWindowState(
                { windowMinutes: 300, usedPercent: 90, resetsAt: 1_000 },
                5_000,
                translate,
            ),
        ).toEqual({ kind: 'reset' });
    });
});

describe('unpriced usage', () => {
    it('shows No price instead of $0 and marks a partly priced figure', () => {
        expect(usageCostDisplay({ costUsd: 0, hasTokens: true, hasUnpriced: true })).toEqual({
            kind: 'unpriced',
        });
        expect(usageCostDisplay({ costUsd: 4.2, hasTokens: true, hasUnpriced: true })).toEqual({
            kind: 'partial',
            label: '$4.20',
        });
        expect(usageCostDisplay({ costUsd: 4.2, hasTokens: true, hasUnpriced: false })).toEqual({
            kind: 'priced',
            label: '$4.20',
        });
    });

    it('finds unpriced models per Agent and says so on the cost tile', () => {
        const models = [
            { provider: 'codex' as const, isPriced: true },
            { provider: 'claude' as const, isPriced: false },
        ];
        expect(hasUnpricedProviderModel(models, 'claude')).toBe(true);
        expect(hasUnpricedProviderModel(models, 'codex')).toBe(false);
        expect(
            costTileDetail(translate, {
                coverage: {
                    agentSessions: 1,
                    unavailable: 0,
                    pendingScans: 0,
                    pendingPullRequests: 0,
                    unpricedModels: ['a', 'b'],
                },
                totals: { cacheSavingsUsd: 1 },
            }),
        ).toBe('Partial: 2 models unpriced');
        expect(
            costTileDetail(
                translate,
                {
                    coverage: {
                        agentSessions: 1,
                        unavailable: 0,
                        pendingScans: 0,
                        pendingPullRequests: 0,
                        unpricedModels: ['a'],
                    },
                    totals: { cacheSavingsUsd: 0 },
                },
                true,
            ),
        ).toBe('1 model without a known price');
    });

    it('never says most spend goes to a model with no spend', () => {
        const insights = buildUsageInsights(translate, {
            activity: [],
            models: [
                {
                    model: 'mystery-model',
                    provider: 'claude',
                    costUsd: 0,
                    isPriced: false,
                    tokens: {
                        input: 1,
                        output: 1,
                        cacheRead: 0,
                        cacheWrite: 0,
                        reasoning: 0,
                        total: 2,
                    },
                },
            ],
            projects: [],
            totals: {
                activeMs: 0,
                cacheSavingsUsd: 0,
                costUsd: 0,
                pullRequestsMerged: 0,
                tokens: { output: 1 },
            },
        });
        expect(insights.some((insight) => insight.startsWith('Most spend'))).toBe(false);
    });

    it('treats a range as unpriced only when it has usage and nothing in it could be priced', () => {
        const report = (costUsd: number, total: number, unpricedModels: string[]) => ({
            coverage: {
                agentSessions: 1,
                unavailable: 0,
                pendingScans: 0,
                pendingPullRequests: 0,
                unpricedModels,
            },
            totals: { costUsd, tokens: { total } },
        });
        expect(isUsageUnpriced(report(0, 10, ['mystery-model']))).toBe(true);
        expect(isUsageUnpriced(report(1.5, 10, ['mystery-model']))).toBe(false);
        expect(isUsageUnpriced(report(0, 0, ['mystery-model']))).toBe(false);
        expect(isUsageUnpriced(report(0, 10, []))).toBe(false);
    });
});

describe('usageLoadFailureReason', () => {
    it('names a closed reason from the error code instead of the raw message', () => {
        expect(
            usageLoadFailureReason(new CaxriError('TIMEOUT', 'request timed out after 30000ms')),
        ).toBe('unavailable');
        expect(usageLoadFailureReason(new CaxriError('UNAVAILABLE', 'socket closed'))).toBe(
            'unavailable',
        );
        expect(usageLoadFailureReason(new CaxriError('IO', 'EACCES: /some/path'))).toBe(
            'unreadable',
        );
        expect(usageLoadFailureReason(new CaxriError('INTERNAL', 'boom'))).toBe('unknown');
        expect(usageLoadFailureReason(new Error('plain'))).toBe('unknown');
        expect(usageLoadFailureReason('string rejection')).toBe('unknown');
    });

    it('never echoes the Server message', () => {
        const text = usageLoadFailureText(translate, new CaxriError('IO', 'EACCES: /private/x'));
        expect(text).not.toContain('EACCES');
        expect(text).toBe(translate('usage.loadFailedReason.unreadable'));
    });
});
