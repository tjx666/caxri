import type { UsageDay } from '@caxri/protocol';
import { formatTokens, formatUsd, localDateWeekday, shiftLocalDate } from '@caxri/protocol';

/**
 * The heatmap always shows the trailing 53 weeks, GitHub style: one column per week, Sunday on top.
 */
export const HEATMAP_WEEKS = 53;

export type UsageMetric = 'tokens' | 'cost';

const SHORT_MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function formatDate(date: string): string {
    const [year, month, day] = date.split('-').map(Number);
    return `${SHORT_MONTHS[month - 1]} ${day}, ${year}`;
}

function monthLabel(date: string): string {
    return SHORT_MONTHS[Number(date.slice(5, 7)) - 1];
}

export function weekdayName(index: number): string {
    return WEEKDAYS[index];
}

export function formatHour(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
}

function metricValue(day: Pick<UsageDay, 'tokens' | 'costUsd'>, metric: UsageMetric) {
    return metric === 'tokens' ? day.tokens : day.costUsd;
}

export function formatMetric(value: number, metric: UsageMetric): string {
    return metric === 'tokens' ? `${formatTokens(value)} tokens` : formatUsd(value);
}

interface HeatmapCell {
    date: string;
    value: number;
    /**
     * 0 for no usage, then 1 to 4 by quartile of the non-zero days, so one outlier day does not wash out the rest.
     */
    level: number;
    isFuture: boolean;
}

export interface HeatmapWeek {
    start: string;
    cells: HeatmapCell[];
    total: number;
    level: number;
    /**
     * Month label to print above this column; set on the first column of each month.
     */
    monthLabel?: string;
}

/**
 * Levels by rank among the non-zero values: the share of values at or below this one, in quarters. The busiest value
 * always reaches level 4 and equal values share a level.
 */
function quartileLevels(values: readonly number[]): (value: number) => number {
    const sorted = values.filter((value) => value > 0).toSorted((a, b) => a - b);
    const levels = new Map<number, number>();
    for (const [index, value] of sorted.entries())
        levels.set(value, Math.ceil(((index + 1) / sorted.length) * 4));
    return (value) => (value > 0 ? (levels.get(value) ?? 0) : 0);
}

/**
 * Lays the trailing {@link HEATMAP_WEEKS} weeks ending `today` out as week columns starting on Sunday.
 */
export function buildHeatmap(
    activity: readonly UsageDay[],
    today: string,
    metric: UsageMetric,
): HeatmapWeek[] {
    const byDate = new Map(activity.map((day) => [day.date, metricValue(day, metric)]));
    const firstDay = shiftLocalDate(today, -((HEATMAP_WEEKS - 1) * 7 + localDateWeekday(today)));
    const weeks: HeatmapWeek[] = [];
    for (let week = 0; week < HEATMAP_WEEKS; week++) {
        const start = shiftLocalDate(firstDay, week * 7);
        const cells = Array.from({ length: 7 }, (_, offset) => {
            const date = shiftLocalDate(start, offset);
            return { date, value: byDate.get(date) ?? 0, level: 0, isFuture: date > today };
        });
        const firstOfMonth = cells.find((cell) => cell.date.endsWith('-01'));
        weeks.push({
            start,
            cells,
            total: cells.reduce((sum, cell) => sum + cell.value, 0),
            level: 0,
            monthLabel:
                week === 0 || firstOfMonth
                    ? monthLabel(firstOfMonth?.date ?? shiftLocalDate(start, 6))
                    : undefined,
        });
    }
    // A label squeezed in front of the first full month would overlap it.
    if (weeks[1]?.monthLabel) weeks[0].monthLabel = undefined;
    const dayLevel = quartileLevels(weeks.flatMap((week) => week.cells.map((cell) => cell.value)));
    const weekLevel = quartileLevels(weeks.map((week) => week.total));
    for (const week of weeks) {
        week.level = weekLevel(week.total);
        for (const cell of week.cells) cell.level = dayLevel(cell.value);
    }
    return weeks;
}

export interface CumulativePoint {
    date: string;
    total: number;
}

/**
 * Running total per day across the heatmap window, including days without usage, so the curve stays flat over idle
 * stretches.
 */
export function buildCumulative(weeks: readonly HeatmapWeek[]): CumulativePoint[] {
    let total = 0;
    return weeks
        .flatMap((week) => week.cells)
        .filter((cell) => !cell.isFuture)
        .map((cell) => {
            total += cell.value;
            return { date: cell.date, total };
        });
}

export interface Streaks {
    current: number;
    longest: number;
}

/**
 * Consecutive local days with any usage. The current streak survives a quiet `today` so it does not reset each morning
 * before the first prompt.
 */
export function computeStreaks(activity: readonly UsageDay[], today: string): Streaks {
    const active = new Set(activity.filter((day) => day.tokens > 0).map((day) => day.date));
    let longest = 0;
    let run = 0;
    let previous: string | undefined;
    const dates = [...active].toSorted((a, b) => a.localeCompare(b));
    for (const date of dates) {
        run = previous && shiftLocalDate(previous, 1) === date ? run + 1 : 1;
        longest = Math.max(longest, run);
        previous = date;
    }
    let current = 0;
    let cursor = active.has(today) ? today : shiftLocalDate(today, -1);
    while (active.has(cursor)) {
        current += 1;
        cursor = shiftLocalDate(cursor, -1);
    }
    return { current, longest };
}

export interface ActivityHighlights {
    busiestDay?: UsageDay;
    activeDays: number;
    /**
     * Weekday (0 is Sunday) carrying the most tokens across the window.
     */
    busiestWeekday?: number;
}

export function activityHighlights(activity: readonly UsageDay[]): ActivityHighlights {
    let busiestDay: UsageDay | undefined;
    const byWeekday = Array.from({ length: 7 }, () => 0);
    let activeDays = 0;
    for (const day of activity) {
        if (day.tokens <= 0) continue;
        activeDays += 1;
        byWeekday[localDateWeekday(day.date)] += day.tokens;
        if (!busiestDay || day.tokens > busiestDay.tokens) busiestDay = day;
    }
    const peak = Math.max(...byWeekday);
    return {
        busiestDay,
        activeDays,
        busiestWeekday: peak > 0 ? byWeekday.indexOf(peak) : undefined,
    };
}

/**
 * Hour with the most tokens, or `undefined` when nothing was used.
 */
export function peakHour(hourOfDay: readonly number[]): number | undefined {
    const peak = Math.max(0, ...hourOfDay);
    return peak > 0 ? hourOfDay.indexOf(peak) : undefined;
}
