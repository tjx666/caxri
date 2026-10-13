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
    formatTokens,
    formatUsd,
    isCaxriError,
    localDateWeekday,
    shiftLocalDate,
} from '@caxri/protocol';

import type { Translate, TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import { formatCount } from '../../lib/locale-format';
import { localizedDuration, localizedLimitReset } from '../../lib/usage-format';

/**
 * The heatmap always shows the trailing 53 weeks, GitHub style: one column per week, Sunday on top.
 */
export const HEATMAP_WEEKS = 53;

export type UsageMetric = 'tokens' | 'cost';

const SHORT_MONTHS: readonly TranslationKey[] = [
    'usage.month.jan',
    'usage.month.feb',
    'usage.month.mar',
    'usage.month.apr',
    'usage.month.may',
    'usage.month.jun',
    'usage.month.jul',
    'usage.month.aug',
    'usage.month.sep',
    'usage.month.oct',
    'usage.month.nov',
    'usage.month.dec',
];
export const WEEKDAYS: readonly TranslationKey[] = [
    'usage.weekday.sunday',
    'usage.weekday.monday',
    'usage.weekday.tuesday',
    'usage.weekday.wednesday',
    'usage.weekday.thursday',
    'usage.weekday.friday',
    'usage.weekday.saturday',
];

/**
 * The Usage page's one date format, `Mar 7, 2026`, for every date it prints.
 */
export function formatDate(t: Translate, date: string): string {
    const [year, month, day] = date.split('-').map(Number);
    return t('usage.date.format', { day, month: t(SHORT_MONTHS[month - 1]), year });
}

/**
 * {@link formatDate} for an epoch-millisecond timestamp, read in the local zone.
 */
export function formatTimestampDate(t: Translate, timestamp: number): string {
    const date = new Date(timestamp);
    return formatDate(
        t,
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
    );
}

/**
 * The nouns {@link countLabel} counts, each with a `One` and an `Other` key in the `usage.count` group.
 */
type UsageCountUnit =
    'agentSession' | 'day' | 'mergedPullRequest' | 'model' | 'pullRequest' | 'session';

/**
 * `1 pull request`, `3 pull requests`.
 */
export function countLabel(t: Translate, count: number, unit: UsageCountUnit): string {
    return t(`usage.count.${unit}${count === 1 ? 'One' : 'Other'}`, {
        count: formatCount(count),
    });
}

/**
 * A truncated list's caption, `Top 12 of 40`, or nothing when every row is shown.
 */
export function topCaption(t: Translate, shown: number, total: number): string | undefined {
    return total > shown ? t('usage.topCaption', { shown, total }) : undefined;
}

/**
 * What the page caption says for a range the user just picked, before its report arrives.
 */
export function usageRangeLabel(t: Translate, range: UsageRange): string {
    return t(`usage.rangeLabel.${range}`);
}

/**
 * The Activity card's accessible name, which follows the metric the chart is drawn in.
 */
export function activityCardLabel(t: Translate, metric: UsageMetric): string {
    return t(metric === 'tokens' ? 'usage.activity.tokenLabel' : 'usage.activity.costLabel');
}

function monthLabel(t: Translate, date: string): string {
    return t(SHORT_MONTHS[Number(date.slice(5, 7)) - 1]);
}

export function formatHour(hour: number): string {
    return `${String(hour).padStart(2, '0')}:00`;
}

function metricValue(day: Pick<UsageDay, 'tokens' | 'costUsd'>, metric: UsageMetric) {
    return metric === 'tokens' ? day.tokens : day.costUsd;
}

export function formatMetric(t: Translate, value: number, metric: UsageMetric): string {
    return metric === 'tokens'
        ? t('usage.metric.tokens', { tokens: formatTokens(value) })
        : formatUsd(value);
}

/**
 * Hover text for one heatmap day: every figure the cell's color stands for, since the color alone is only a quartile. A
 * day with tokens but no cost could not be priced (a priced model never bills zero for real usage), so it reads `No
 * price` like the stat cards instead of a `$0` that would claim the usage was free.
 */
export function usageDayTooltip(t: Translate, date: string, day: UsageDay | undefined): string {
    const detail =
        !day || day.tokens === 0
            ? t('usage.noUsage')
            : t('usage.activity.dayDetail', {
                  cost: day.costUsd > 0 ? formatUsd(day.costUsd) : t('usage.cost.noPrice'),
                  duration: localizedDuration(day.activeMs, t),
                  tokens: formatTokens(day.tokens),
              });
    return `${formatDate(t, date)} · ${detail}`;
}

/**
 * Hover text for one Time of day bar, naming the hour as a span so `11:00` does not read as a single instant.
 */
export function usageHourTooltip(t: Translate, hour: number, tokens: number): string {
    const span = `${formatHour(hour)}–${formatHour((hour + 1) % 24)}`;
    return `${span} · ${tokens > 0 ? formatMetric(t, tokens, 'tokens') : t('usage.noUsage')}`;
}

/**
 * Hover text for one weekly bar, shared by its Tooltip and the keyboard readout so both read the same figure.
 */
export function usageWeekTooltip(
    t: Translate,
    week: Pick<HeatmapWeek, 'start' | 'total'>,
    metric: UsageMetric,
): string {
    return t('usage.activity.weekTooltip', {
        date: formatDate(t, week.start),
        value: week.total > 0 ? formatMetric(t, week.total, metric) : t('usage.noUsage'),
    });
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
    t: Translate,
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
                    ? monthLabel(t, firstOfMonth?.date ?? shiftLocalDate(start, 6))
                    : undefined,
        });
    }
    // A label squeezed in front of the first full month would overlap it, and the leading partial month is the same
    // month as today's a year earlier, so labelling it printed `Oct` at both ends of the chart.
    if (weeks[1]?.monthLabel || weeks[0].monthLabel === monthLabel(t, today))
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
    t: Translate,
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
            title: t('usage.empty.agentFilter', {
                agent: agentProviderCatalog[agent].displayName,
            }),
        };
    if (agentSessions === 0) return { kind: 'noUsage' };
    return undefined;
}

/**
 * The Agent time tile's detail line. Agent Sessions run outside Caxri have no Caxri Session, so they are counted beside
 * the Sessions rather than as more of them.
 */
export function agentTimeDetail(
    t: Translate,
    totals: Pick<UsageReport['totals'], 'sessionsWithUsage' | 'outsideSessionsWithUsage'>,
): string {
    const sessions = countLabel(t, totals.sessionsWithUsage, 'session');
    return totals.outsideSessionsWithUsage > 0
        ? t('usage.agentTime.acrossWithOutside', {
              outside: formatCount(totals.outsideSessionsWithUsage),
              sessions,
          })
        : t('usage.agentTime.across', { sessions });
}

/**
 * A row's count. Rows that include Agent Sessions run outside Caxri count Agent Sessions, not Sessions, because those
 * have no Caxri Session.
 */
export function usageSessionCount(t: Translate, count: number, isOutsideCaxri: boolean): string {
    return countLabel(t, count, isOutsideCaxri ? 'agentSession' : 'session');
}

/**
 * The page caption's progress note while the Server is still reading transcripts in the background.
 */
export function usageScanCaption(
    t: Translate,
    report: { coverage: Pick<UsageReport['coverage'], 'pendingScans' | 'outsideCaxri'> },
): string | undefined {
    const pending = pendingTranscriptScans(report);
    return pending > 0
        ? t(pending === 1 ? 'usage.scan.readingOne' : 'usage.scan.readingOther', {
              count: formatCount(pending),
          })
        : undefined;
}

/**
 * The page caption's refresh state. With `keepPreviousData` a failed refetch leaves the previous report on screen and
 * nothing else would say the figures are stale, so the caption reports it with a retry.
 */
export function didUsageRefreshFail(query: { data: unknown; isError: boolean }): boolean {
    return query.data !== undefined && query.isError;
}

/**
 * The closed set of reasons the Usage page names when its first report fails. The Server's message is diagnostic text
 * (a path, an errno, a stack-shaped sentence) and never reaches the page; the reason is chosen from the error code.
 */
export type UsageLoadFailureReason = 'unavailable' | 'unreadable' | 'unknown';

export function usageLoadFailureReason(error: unknown): UsageLoadFailureReason {
    if (!isCaxriError(error)) return 'unknown';
    switch (error.code) {
        case 'UNAVAILABLE':
        case 'TIMEOUT':
        case 'CAPACITY':
        case 'CANCELLED': {
            return 'unavailable';
        }
        case 'IO':
        case 'PATH_DENIED':
        case 'FORBIDDEN':
        case 'NOT_FOUND': {
            return 'unreadable';
        }
        default: {
            return 'unknown';
        }
    }
}

export function usageLoadFailureText(t: Translate, error: unknown): string {
    return t(`usage.loadFailedReason.${usageLoadFailureReason(error)}`);
}

/**
 * The burn-rate card's caption: the 30-day pace projected to a month. Prefixed `est.` and suffixed with the price
 * basis, because a dollar figure on its own reads as a bill and a subscription plan is billed differently.
 */
export function burnRateCaption(
    t: Translate,
    last30DaysCostUsd: number,
    isUnpriced = false,
): string {
    if (isUnpriced) return t('usage.burn.captionUnpriced');
    return t('usage.burn.caption', { cost: formatUsd((last30DaysCostUsd / 30) * 30.4) });
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
 * A plan-limit window as of the report. Once `resetsAt` has passed, the percentage the Agent last reported belongs to a
 * window that no longer exists, and the next figure arrives only with the Agent's next response, so the window is
 * `reset` rather than a stale `resets now`. Judged against `generatedAt`, which moves with every refresh, so render
 * stays pure.
 */
export type LimitWindowState = { kind: 'active'; resetLabel?: string } | { kind: 'reset' };

export function limitWindowState(
    window: UsageLimit['windows'][number],
    generatedAt: number,
    t: Translate = translate,
): LimitWindowState {
    if (window.resetsAt === undefined) return { kind: 'active' };
    if (window.resetsAt <= generatedAt) return { kind: 'reset' };
    return { kind: 'active', resetLabel: localizedLimitReset(window.resetsAt, generatedAt, t) };
}

/**
 * How a cost cell reads when some usage has no known price: `No price` when nothing in it could be priced (a `$0` there
 * would claim it was free), and `partial` when the figure leaves some usage out. Matches the Models table. The unpriced
 * variant carries no label: `UsageCost` words it in the active language.
 */
export type UsageCostDisplay =
    { kind: 'priced'; label: string } | { kind: 'partial'; label: string } | { kind: 'unpriced' };

export function usageCostDisplay({
    costUsd,
    hasTokens,
    hasUnpriced,
}: {
    costUsd: number;
    hasTokens: boolean;
    hasUnpriced: boolean;
}): UsageCostDisplay {
    if (hasUnpriced && hasTokens && costUsd <= 0) return { kind: 'unpriced' };
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
    t: Translate,
    report: Pick<UsageReport, 'coverage'> & {
        totals: Pick<UsageReport['totals'], 'cacheSavingsUsd'>;
    },
    isUnpriced = false,
): string {
    const unpriced = report.coverage.unpricedModels.length;
    if (isUnpriced)
        return t('usage.cost.unpricedModels', { models: countLabel(t, unpriced, 'model') });
    if (unpriced > 0)
        return t('usage.cost.partialModels', { models: countLabel(t, unpriced, 'model') });
    return t('usage.cost.cacheSavings', { savings: formatUsd(report.totals.cacheSavingsUsd) });
}
