import type {
    AgentProvider,
    UsageDay,
    UsageLimit,
    UsageRange,
    UsageReport,
    UsageSessionRow,
} from '@caxri/protocol';
import {
    agentProviderCatalog,
    formatDuration,
    formatLimitReset,
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

/**
 * The Usage page's one date format, `Mar 7, 2026`, for every date it prints.
 */
export function formatDate(date: string): string {
    const [year, month, day] = date.split('-').map(Number);
    return `${SHORT_MONTHS[month - 1]} ${day}, ${year}`;
}

/**
 * {@link formatDate} for an epoch-millisecond timestamp, read in the local zone.
 */
function formatTimestampDate(timestamp: number): string {
    const date = new Date(timestamp);
    return formatDate(
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    );
}

/**
 * `1 pull request`, `3 pull requests`.
 */
export function countLabel(count: number, singular: string, plural = `${singular}s`): string {
    return `${count.toLocaleString('en-US')} ${count === 1 ? singular : plural}`;
}

/**
 * A truncated list's caption, `Top 12 of 40`, or nothing when every row is shown.
 */
export function topCaption(shown: number, total: number): string | undefined {
    return total > shown ? `Top ${shown} of ${total}` : undefined;
}

const RANGE_LABELS: Record<UsageRange, string> = {
    '7d': 'Last 7 days',
    '30d': 'Last 30 days',
    '90d': 'Last 90 days',
    '365d': 'Last year',
    'all': 'All time',
};

/**
 * What the page caption says for a range the user just picked, before its report arrives.
 */
export function usageRangeLabel(range: UsageRange): string {
    return RANGE_LABELS[range];
}

/**
 * The Activity card's accessible name, which follows the metric the chart is drawn in.
 */
export function activityCardLabel(metric: UsageMetric): string {
    return metric === 'tokens' ? 'Token activity' : 'Cost activity';
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

/**
 * Hover text for one heatmap day: every figure the cell's color stands for, since the color alone is only a quartile.
 */
export function usageDayTooltip(date: string, day: UsageDay | undefined): string {
    const detail =
        !day || day.tokens === 0
            ? 'No usage'
            : `${formatTokens(day.tokens)} tokens · ${formatUsd(day.costUsd)} · ${formatDuration(day.activeMs)} active`;
    return `${formatDate(date)} · ${detail}`;
}

/**
 * Hover text for one Time of day bar, naming the hour as a span so `11:00` does not read as a single instant.
 */
export function usageHourTooltip(hour: number, tokens: number): string {
    const span = `${formatHour(hour)}–${formatHour((hour + 1) % 24)}`;
    return `${span} · ${tokens > 0 ? `${formatTokens(tokens)} tokens` : 'No usage'}`;
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
    // A label squeezed in front of the first full month would overlap it, and the leading partial month is the same
    // month as today's a year earlier, so labelling it printed `Oct` at both ends of the chart.
    if (weeks[1]?.monthLabel || weeks[0].monthLabel === monthLabel(today))
        weeks[0].monthLabel = undefined;
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
 * - `scanning`: the background read of transcripts has found nothing yet, so "no usage" would be premature.
 * - `noUsage`: no Agent conversation was ever recorded.
 */
export type UsageEmptyState =
    { kind: 'agentFilter'; title: string } | { kind: 'scanning' } | { kind: 'noUsage' };

/**
 * Transcripts the Server is still reading in the background, inside and outside Caxri Sessions.
 */
export function pendingTranscriptScans(report: {
    coverage: Pick<UsageReport['coverage'], 'pendingScans' | 'outsideCaxri'>;
}): number {
    return report.coverage.pendingScans + (report.coverage.outsideCaxri?.pendingScans ?? 0);
}

export function usageEmptyState(
    report: {
        coverage: Pick<UsageReport['coverage'], 'agentSessions' | 'pendingScans' | 'outsideCaxri'>;
        totals: { tokens: Pick<UsageReport['totals']['tokens'], 'total'> };
    },
    agent: AgentProvider | undefined,
): UsageEmptyState | undefined {
    if (report.totals.tokens.total === 0 && pendingTranscriptScans(report) > 0)
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
    const sessions = `Across ${countLabel(totals.sessionsWithUsage, 'Session')}`;
    return totals.outsideSessionsWithUsage > 0
        ? `${sessions} + ${totals.outsideSessionsWithUsage.toLocaleString('en-US')} outside`
        : sessions;
}

/**
 * A row's count. Rows that include Agent Sessions run outside Caxri count Agent Sessions, not Sessions, because those
 * have no Caxri Session.
 */
export function usageSessionCount(count: number, isOutsideCaxri: boolean): string {
    return countLabel(count, isOutsideCaxri ? 'Agent Session' : 'Session');
}

/**
 * The page caption's progress note while the Server is still reading transcripts in the background.
 */
export function usageScanCaption(report: {
    coverage: Pick<UsageReport['coverage'], 'pendingScans' | 'outsideCaxri'>;
}): string | undefined {
    const pending = pendingTranscriptScans(report);
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
    const counted = `${countLabel(coverage.agentSessions, 'Agent Session')} started in Caxri Sessions, including archived and deleted Sessions`;
    const outside = coverage.outsideCaxri?.agentSessions ?? 0;
    const notes = [
        `Costs are estimated from public API list prices (${pricing.source === 'bundled' ? 'bundled price list' : `LiteLLM prices updated ${pricing.updatedAt ? formatTimestampDate(pricing.updatedAt) : 'recently'}`}); a subscription plan bills differently.`,
        report.scope === 'all'
            ? `Counts ${counted}, plus ${outside.toLocaleString('en-US')} run outside Caxri on this Mac.`
            : `Counts ${counted}.`,
    ];
    // An unread row has no aggregate yet either; only a finished scan proves the transcript is gone.
    if (coverage.unavailable > 0 && coverage.pendingScans === 0)
        notes.push(
            `${coverage.unavailable.toLocaleString('en-US')} ${coverage.unavailable === 1 ? 'Agent Session has' : 'Agent Sessions have'} no transcript on this machine, so their usage is missing.`,
        );
    if (coverage.pendingPullRequests > 0)
        notes.push(
            `Checking ${countLabel(coverage.pendingPullRequests, 'pull request')} on GitHub.`,
        );
    if (coverage.unpricedModels.length > 0)
        // Worded like every cost cell ("No price") rather than "$0", which read as "this usage was free".
        notes.push(
            `No price for ${coverage.unpricedModels.join(', ')}; their usage is left out of every cost figure.`,
        );
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
export function burnRateCaption(last30DaysCostUsd: number, isUnpriced = false): string {
    if (isUnpriced) return 'Last 30 days · no price for the models used';
    return `Last 30 days · est. ${formatUsd((last30DaysCostUsd / 30) * 30.4)}/month at API prices`;
}

/**
 * Whether the range has usage but none of it could be priced, so every dollar figure on the page would read `$0` and
 * claim the usage was free. Cost cells then say `No price` and per-day rates are left out.
 */
export function isUsageUnpriced(
    report: Pick<UsageReport, 'coverage'> & {
        totals: Pick<UsageReport['totals'], 'costUsd'> & {
            tokens: Pick<UsageReport['totals']['tokens'], 'total'>;
        };
    },
): boolean {
    return (
        usageCostDisplay({
            costUsd: report.totals.costUsd,
            hasTokens: report.totals.tokens.total > 0,
            hasUnpriced: report.coverage.unpricedModels.length > 0,
        }).kind === 'unpriced'
    );
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
            `Busiest day: ${formatDate(highlights.busiestDay.date)} with ${formatTokens(highlights.busiestDay.tokens)} tokens${highlights.busiestDay.costUsd > 0 ? ` (${formatUsd(highlights.busiestDay.costUsd)})` : ''}.`,
        );
    // "Day of the week", not "weekday": the busiest one is often a Saturday or Sunday.
    if (highlights.busiestWeekday !== undefined)
        insights.push(`${weekdayName(highlights.busiestWeekday)} is your busiest day of the week.`);
    if (topProject && totals.costUsd > 0)
        insights.push(
            `${topProject.title} accounts for ${formatPercent(topProject.costUsd / totals.costUsd)} of the spend.`,
        );
    // A model whose spend is $0 (unpriced, or nothing billed yet) does not receive "most spend".
    if (topModel && topModel.costUsd > 0) insights.push(`Most spend goes to ${topModel.model}.`);
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

/**
 * A plan-limit window as of the report. Once `resetsAt` has passed, the percentage the Agent last reported belongs to a
 * window that no longer exists, and the next figure arrives only with the Agent's next response, so the window is
 * `reset` rather than a stale `resets now`. Judged against `generatedAt`, which moves with every refresh, so render
 * stays pure.
 */
export type LimitWindowState = { kind: 'active'; resetLabel?: string } | { kind: 'reset' };

export function limitWindowState(
    window: UsageLimit['windows'][number],
    generatedAt: number,
): LimitWindowState {
    if (window.resetsAt === undefined) return { kind: 'active' };
    if (window.resetsAt <= generatedAt) return { kind: 'reset' };
    return { kind: 'active', resetLabel: formatLimitReset(window.resetsAt, generatedAt) };
}

/**
 * How a cost cell reads when some usage has no known price: `No price` when nothing in it could be priced (a `$0` there
 * would claim it was free), and `partial` when the figure leaves some usage out. Matches the Models table.
 */
export type UsageCostDisplay =
    | { kind: 'priced'; label: string }
    | { kind: 'partial'; label: string }
    | { kind: 'unpriced'; label: 'No price' };

export function usageCostDisplay({
    costUsd,
    hasTokens,
    hasUnpriced,
}: {
    costUsd: number;
    hasTokens: boolean;
    hasUnpriced: boolean;
}): UsageCostDisplay {
    if (hasUnpriced && hasTokens && costUsd <= 0) return { kind: 'unpriced', label: 'No price' };
    if (hasUnpriced) return { kind: 'partial', label: formatUsd(costUsd) };
    return { kind: 'priced', label: formatUsd(costUsd) };
}

/**
 * Whether any model this Agent used in the range has no known price.
 */
export function hasUnpricedProviderModel(
    models: ReadonlyArray<Pick<UsageReport['models'][number], 'isPriced' | 'provider'>>,
    provider: AgentProvider,
): boolean {
    return models.some((model) => model.provider === provider && !model.isPriced);
}

/**
 * The cost tile's detail: which figure is incomplete comes first, since every other number on the page inherits it.
 */
export function costTileDetail(
    report: Pick<UsageReport, 'coverage'> & {
        totals: Pick<UsageReport['totals'], 'cacheSavingsUsd'>;
    },
    isUnpriced = false,
): string {
    const unpriced = report.coverage.unpricedModels.length;
    if (isUnpriced) return `${countLabel(unpriced, 'model')} without a known price`;
    if (unpriced > 0) return `Partial: ${countLabel(unpriced, 'model')} unpriced`;
    return `${formatUsd(report.totals.cacheSavingsUsd)} cache savings`;
}
