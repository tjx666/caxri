import type { UsageDay } from '@caxri/protocol';
import { shiftLocalDate } from '@caxri/protocol';

import type { Translate } from '../../i18n';
import type { ChartCursorLayout } from './usage-chart-cursor';
import type { CumulativePoint, HeatmapWeek, UsageMetric } from './usage-metrics';
import {
    activityHighlights,
    formatDate,
    formatMetric,
    usageDayTooltip,
    usageWeekTooltip,
} from './usage-metrics';

export type ActivityView = 'daily' | 'weekly' | 'cumulative';

export const ACTIVITY_VIEWS: readonly ActivityView[] = ['daily', 'weekly', 'cumulative'];

/**
 * The cumulative chart's readout for one point, which has no Tooltip of its own.
 */
export interface ActivityHoverTarget {
    label: string;
    detail: string;
}

export function cumulativeTarget(
    t: Translate,
    point: CumulativePoint,
    metric: UsageMetric,
): ActivityHoverTarget {
    return {
        label: t('usage.activity.through', { date: formatDate(t, point.date) }),
        detail: formatMetric(t, point.total, metric),
    };
}

/**
 * The keyboard cursor's layout for a view. Daily cells and cumulative points both index the heatmap's non-future days,
 * column-major, so one index names the same day in either view.
 */
export function activityCursorLayout(
    view: ActivityView,
    weekCount: number,
    pointCount: number,
): ChartCursorLayout {
    return view === 'daily'
        ? { kind: 'grid', count: pointCount, rows: 7 }
        : { kind: 'linear', count: view === 'weekly' ? weekCount : pointCount };
}

/**
 * The caption and live-region text for the keyboard cursor's item: the same text its Tooltip shows, or the cumulative
 * point's readout.
 */
export function activityCursorText(
    t: Translate,
    {
        cursor,
        days,
        metric,
        points,
        view,
        weeks,
    }: {
        cursor: number | undefined;
        days: ReadonlyMap<string, UsageDay>;
        metric: UsageMetric;
        points: readonly CumulativePoint[];
        view: ActivityView;
        weeks: readonly HeatmapWeek[];
    },
): string | undefined {
    if (cursor === undefined) return undefined;
    if (view === 'weekly') return usageWeekTooltip(t, weeks[cursor], metric);
    if (view === 'daily')
        return usageDayTooltip(t, points[cursor].date, days.get(points[cursor].date));
    const target = cumulativeTarget(t, points[cursor], metric);
    return `${target.label} · ${target.detail}`;
}

/**
 * The trailing year's summary (active days and total), and the chart's accessible name, which adds the busiest day.
 */
export function activityYearSummary(
    t: Translate,
    activity: readonly UsageDay[],
    today: string,
    metric: UsageMetric,
): { summary: string; chartLabel: string } {
    const yearStart = shiftLocalDate(today, -364);
    const yearDays = activity.filter((day) => day.date >= yearStart);
    const yearTotal = yearDays.reduce(
        (sum, day) => sum + (metric === 'tokens' ? day.tokens : day.costUsd),
        0,
    );
    const activeDays = yearDays.filter((day) => day.tokens > 0).length;
    const summary = t(
        activeDays === 1 ? 'usage.activity.summaryOne' : 'usage.activity.summaryOther',
        { count: activeDays, value: formatMetric(t, yearTotal, metric) },
    );
    const busiestDay = activityHighlights(yearDays).busiestDay;
    const chartLabel = busiestDay
        ? t('usage.activity.chartLabel', {
              busiestDay: usageDayTooltip(t, busiestDay.date, busiestDay),
              summary,
          })
        : summary;
    return { summary, chartLabel };
}
