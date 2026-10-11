import type { AgentProvider, UsageDay, UsageReport, UsageSessionRow } from '@caxri/protocol';
import {
    agentProviderCatalog,
    formatDuration,
    formatPercent,
    formatTokens,
    formatUsd,
    localDateWeekday,
    shiftLocalDate,
} from '@caxri/protocol';

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

function weekdayName(index: number): string {
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

/**
 * What the Usage page shows instead of its sections, or `undefined` when the report has something to show.
 *
 * - `agentFilter`: one Agent is selected and it used nothing in the range. Saying "No Agent usage yet" there blamed the
 *   whole page on a filter the user may have forgotten, so the copy names the Agent and offers to clear the filter.
 * - `scanning`: the first read of transcripts outside Caxri has found nothing yet, so "no usage" would be premature.
 * - `noUsage`: no Agent conversation was ever recorded.
 */
export type UsageEmptyState =
    { kind: 'agentFilter'; title: string } | { kind: 'scanning' } | { kind: 'noUsage' };

export function usageEmptyState(
    report: {
        coverage: Pick<UsageReport['coverage'], 'agentSessions' | 'outsideCaxri'>;
        totals: { tokens: Pick<UsageReport['totals']['tokens'], 'total'> };
    },
    agent: AgentProvider | undefined,
): UsageEmptyState | undefined {
    if (report.totals.tokens.total === 0 && (report.coverage.outsideCaxri?.pendingScans ?? 0) > 0)
        return { kind: 'scanning' };
    const agentSessions =
        report.coverage.agentSessions + (report.coverage.outsideCaxri?.agentSessions ?? 0);
    if (agent !== undefined && (agentSessions === 0 || report.totals.tokens.total === 0))
        return {
            kind: 'agentFilter',
            title: `No ${agentProviderCatalog[agent].displayName} usage in this range`,
        };
    if (agentSessions === 0) return { kind: 'noUsage' };
    return undefined;
}

/**
 * The Agent time tile's detail line. Agent Sessions run outside Caxri have no Caxri Session, so they are counted beside
 * the Sessions rather than as more of them.
 */
export function agentTimeDetail(
    totals: Pick<UsageReport['totals'], 'sessionsWithUsage' | 'outsideSessionsWithUsage'>,
): string {
    const sessions = `Across ${totals.sessionsWithUsage} ${totals.sessionsWithUsage === 1 ? 'Session' : 'Sessions'}`;
    return totals.outsideSessionsWithUsage > 0
        ? `${sessions} + ${totals.outsideSessionsWithUsage} outside`
        : sessions;
}

/**
 * A row's count of Agent conversations. Rows that include conversations run outside Caxri count conversations, not
 * Sessions, because those conversations have no Caxri Session.
 */
export function usageSessionCount(count: number, isOutsideCaxri: boolean): string {
    if (isOutsideCaxri) return `${count} ${count === 1 ? 'conversation' : 'conversations'}`;
    return `${count} ${count === 1 ? 'Session' : 'Sessions'}`;
}

/**
 * The page caption's progress note while the first read of transcripts outside Caxri is still running.
 */
export function usageScanCaption(report: {
    coverage: Pick<UsageReport['coverage'], 'outsideCaxri'>;
}): string | undefined {
    const pending = report.coverage.outsideCaxri?.pendingScans ?? 0;
    return pending > 0
        ? `Reading ${pending.toLocaleString('en-US')} more ${pending === 1 ? 'transcript' : 'transcripts'}…`
        : undefined;
}

/**
 * The footnotes under the report: what it counts, what it is missing, and why.
 */
export function usageCoverageNotes(
    report: Pick<UsageReport, 'coverage' | 'pricing' | 'scope'>,
): string[] {
    const { coverage, pricing } = report;
    const counted = `${coverage.agentSessions} Agent ${coverage.agentSessions === 1 ? 'conversation' : 'conversations'} started in Caxri Sessions, including archived and deleted Sessions`;
    const outside = coverage.outsideCaxri?.agentSessions ?? 0;
    const notes = [
        `Costs are estimated from public API list prices (${pricing.source === 'bundled' ? 'bundled price list' : `LiteLLM prices updated ${pricing.updatedAt ? new Date(pricing.updatedAt).toLocaleDateString() : 'recently'}`}); a subscription plan bills differently.`,
        report.scope === 'all'
            ? `Counts ${counted}, plus ${outside} run outside Caxri on this Mac.`
            : `Counts ${counted}.`,
    ];
    if (coverage.unavailable > 0)
        notes.push(
            `${coverage.unavailable} ${coverage.unavailable === 1 ? 'conversation has' : 'conversations have'} no transcript on this machine, so their usage is missing.`,
        );
    if (coverage.pendingPullRequests > 0)
        notes.push(`Checking ${coverage.pendingPullRequests} pull requests on GitHub.`);
    if (coverage.unpricedModels.length > 0)
        notes.push(`No price for ${coverage.unpricedModels.join(', ')}; counted as $0.`);
    return notes;
}

/**
 * The page caption's refresh state. With `keepPreviousData` a failed refetch leaves the previous report on screen and
 * nothing else would say the figures are stale, so the caption reports it with a retry.
 */
export function didUsageRefreshFail(query: { data: unknown; isError: boolean }): boolean {
    return query.data !== undefined && query.isError;
}

/**
 * The burn-rate card's caption: the 30-day pace projected to a month. Prefixed `est.` and suffixed with the price
 * basis, because a dollar figure on its own reads as a bill and a subscription plan is billed differently.
 */
export function burnRateCaption(last30DaysCostUsd: number): string {
    return `Last 30 days · est. ${formatUsd((last30DaysCostUsd / 30) * 30.4)}/month at API prices`;
}

/**
 * Whether a Most expensive Sessions row can switch to its Session. A deleted Session has nothing to open, an archived
 * one is not in the PrimarySidebar to select, and an Agent Session run outside Caxri has no Session at all.
 */
export function canOpenUsageSession(
    row: Pick<UsageSessionRow, 'isArchived' | 'isDeleted' | 'isOutsideCaxri'>,
): boolean {
    return !row.isArchived && !row.isDeleted && !row.isOutsideCaxri;
}

/**
 * The shortest Agent time an hourly rate is projected from. A few seconds of measured activity extrapolated to an hour
 * printed `144M output tokens per active hour` against a total of 2k tokens.
 */
const MIN_HOURLY_RATE_ACTIVE_MS = 60_000;

/**
 * The Highlights card's sentences, in display order. Each one appears only when its figure is meaningful.
 */
export function buildUsageInsights(
    report: Pick<UsageReport, 'activity' | 'models' | 'projects'> & {
        totals: Pick<
            UsageReport['totals'],
            'activeMs' | 'cacheSavingsUsd' | 'costUsd' | 'pullRequestsMerged'
        > & { tokens: Pick<UsageReport['totals']['tokens'], 'output'> };
    },
): string[] {
    const highlights = activityHighlights(report.activity);
    const { totals } = report;
    const topProject = report.projects.at(0);
    const topModel = report.models.at(0);
    const output = totals.tokens.output;
    const insights: string[] = [];
    if (highlights.busiestDay)
        insights.push(
            `Busiest day: ${formatDate(highlights.busiestDay.date)} with ${formatTokens(highlights.busiestDay.tokens)} tokens (${formatUsd(highlights.busiestDay.costUsd)}).`,
        );
    // "Day of the week", not "weekday": the busiest one is often a Saturday or Sunday.
    if (highlights.busiestWeekday !== undefined)
        insights.push(`${weekdayName(highlights.busiestWeekday)} is your busiest day of the week.`);
    if (topProject && totals.costUsd > 0)
        insights.push(
            `${topProject.title} accounts for ${formatPercent(topProject.costUsd / totals.costUsd)} of the spend.`,
        );
    if (topModel) insights.push(`Most spend goes to ${topModel.model}.`);
    if (totals.cacheSavingsUsd > 0)
        insights.push(
            `Prompt caching saved ${formatUsd(totals.cacheSavingsUsd)}, ${formatPercent(totals.cacheSavingsUsd / (totals.cacheSavingsUsd + totals.costUsd))} of what the same tokens would cost uncached.`,
        );
    if (output > 0 && totals.activeMs >= MIN_HOURLY_RATE_ACTIVE_MS)
        insights.push(
            `Agents wrote ${formatTokens(Math.round(output / (totals.activeMs / 3_600_000)))} output tokens per active hour.`,
        );
    if (totals.pullRequestsMerged > 0)
        insights.push(
            `Each merged pull request took ${formatDuration(totals.activeMs / totals.pullRequestsMerged)} of Agent time on average.`,
        );
    return insights;
}
