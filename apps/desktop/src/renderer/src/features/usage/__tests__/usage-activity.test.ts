import type { UsageDay } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import {
    activityCursorLayout,
    activityCursorText,
    activityYearSummary,
    cumulativeTarget,
} from '../usage-activity';
import {
    buildCumulative,
    buildHeatmap,
    formatMetric,
    usageDayTooltip,
    usageWeekTooltip,
} from '../usage-metrics';

function day(date: string, tokens: number, costUsd = 0): UsageDay {
    return { date, tokens, costUsd, activeMs: 0 };
}

/**
 * A Tuesday.
 */
const TODAY = '2026-03-10';

describe('activityCursorLayout', () => {
    it('steps days as a seven-row grid, weeks and points as a line', () => {
        expect(activityCursorLayout('daily', 53, 360)).toEqual({
            kind: 'grid',
            count: 360,
            rows: 7,
        });
        expect(activityCursorLayout('weekly', 53, 360)).toEqual({ kind: 'linear', count: 53 });
        expect(activityCursorLayout('cumulative', 53, 360)).toEqual({ kind: 'linear', count: 360 });
    });
});

describe('activityCursorText', () => {
    const activity = [day('2026-03-08', 2), day(TODAY, 3)];
    const weeks = buildHeatmap(translate, activity, TODAY, 'tokens');
    const points = buildCumulative(weeks);
    const days = new Map(activity.map((entry) => [entry.date, entry]));
    const base = { days, metric: 'tokens' as const, points, weeks };
    const last = points.length - 1;

    it('reads nothing without a cursor', () => {
        expect(activityCursorText(translate, { ...base, cursor: undefined, view: 'daily' })).toBe(
            undefined,
        );
    });

    it('reads the same text as the day or week Tooltip', () => {
        expect(activityCursorText(translate, { ...base, cursor: last, view: 'daily' })).toBe(
            usageDayTooltip(translate, TODAY, days.get(TODAY)),
        );
        expect(
            activityCursorText(translate, { ...base, cursor: weeks.length - 1, view: 'weekly' }),
        ).toBe(usageWeekTooltip(translate, weeks.at(-1)!, 'tokens'));
    });

    it('joins a cumulative point label and its running total', () => {
        const target = cumulativeTarget(translate, points[last], 'tokens');
        expect(target.detail).toBe(formatMetric(translate, 5, 'tokens'));
        expect(activityCursorText(translate, { ...base, cursor: last, view: 'cumulative' })).toBe(
            `${target.label} · ${target.detail}`,
        );
    });
});

describe('activityYearSummary', () => {
    it('counts only the trailing year and names the busiest day in the chart label', () => {
        const activity = [day('2025-03-10', 100), day('2025-03-11', 1), day(TODAY, 4)];
        const { summary, chartLabel } = activityYearSummary(translate, activity, TODAY, 'tokens');

        expect(summary).toBe(
            translate('usage.activity.summaryOther', {
                count: 2,
                value: formatMetric(translate, 5, 'tokens'),
            }),
        );
        expect(chartLabel).toBe(
            translate('usage.activity.chartLabel', {
                busiestDay: usageDayTooltip(translate, TODAY, activity[2]),
                summary,
            }),
        );
    });

    it('falls back to the summary alone when the year had no usage', () => {
        const { summary, chartLabel } = activityYearSummary(translate, [], TODAY, 'cost');
        expect(chartLabel).toBe(summary);
    });
});
