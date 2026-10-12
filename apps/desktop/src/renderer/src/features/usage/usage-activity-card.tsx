import { useMemo, useState } from 'react';

import type { UsageDay } from '@caxri/protocol';
import { shiftLocalDate } from '@caxri/protocol';

import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { HeatmapWeek, UsageMetric } from './usage-metrics';
import {
    activityCardLabel,
    activityHighlights,
    buildCumulative,
    buildHeatmap,
    formatDate,
    formatMetric,
    usageDayTooltip,
} from './usage-metrics';

type ActivityView = 'daily' | 'weekly' | 'cumulative';

const ACTIVITY_VIEWS: readonly ActivityView[] = ['daily', 'weekly', 'cumulative'];

/**
 * Intensity steps over the `--chart` role, GitHub style. Level 0 is an empty day on the card's own elevated fill.
 */
const LEVEL_CLASSES = ['bg-elevated', 'bg-chart/25', 'bg-chart/50', 'bg-chart/75', 'bg-chart'];
const WEEKDAY_LABELS: ReadonlyArray<TranslationKey | undefined> = [
    undefined,
    'usage.activity.weekdayMon',
    undefined,
    'usage.activity.weekdayWed',
    undefined,
    'usage.activity.weekdayFri',
    undefined,
];

interface HoverTarget {
    label: string;
    detail: string;
}

function MonthLabels({ weeks }: { weeks: readonly HeatmapWeek[] }) {
    return (
        <div className="grid grid-cols-[repeat(53,minmax(0,1fr))] gap-0.5" aria-hidden="true">
            {weeks.map((week) => (
                <span
                    key={week.start}
                    className="overflow-visible text-[11px] whitespace-nowrap text-muted"
                >
                    {week.monthLabel ?? ''}
                </span>
            ))}
        </div>
    );
}

function DailyGrid({
    weeks,
    days,
}: {
    weeks: readonly HeatmapWeek[];
    days: ReadonlyMap<string, UsageDay>;
}) {
    const { t } = useTranslation();
    return (
        <div className="grid grid-cols-[repeat(53,minmax(0,1fr))] gap-0.5">
            {weeks.map((week) => (
                <div key={week.start} className="grid grid-rows-7 gap-0.5">
                    {week.cells.map((cell) =>
                        cell.isFuture ? (
                            <div key={cell.date} className="aspect-square" />
                        ) : (
                            <Tooltip
                                key={cell.date}
                                content={usageDayTooltip(t, cell.date, days.get(cell.date))}
                            >
                                <div
                                    className={cn(
                                        'aspect-square rounded-sm',
                                        LEVEL_CLASSES[cell.level],
                                    )}
                                />
                            </Tooltip>
                        ),
                    )}
                </div>
            ))}
        </div>
    );
}

function WeeklyBars({ weeks, metric }: { weeks: readonly HeatmapWeek[]; metric: UsageMetric }) {
    const { t } = useTranslation();
    const peak = Math.max(0, ...weeks.map((week) => week.total));
    return (
        <div className="grid h-28 grid-cols-[repeat(53,minmax(0,1fr))] items-end gap-0.5">
            {/* The full-height column is the trigger, so a short week's bar is as easy to hover as the peak. */}
            {weeks.map((week) => (
                <Tooltip
                    key={week.start}
                    content={t('usage.activity.weekTooltip', {
                        date: formatDate(t, week.start),
                        value:
                            week.total > 0
                                ? formatMetric(t, week.total, metric)
                                : t('usage.noUsage'),
                    })}
                >
                    <div className="flex h-full items-end">
                        <div
                            className={cn(
                                'w-full rounded-sm',
                                week.total > 0
                                    ? LEVEL_CLASSES[Math.max(1, week.level)]
                                    : 'bg-elevated',
                            )}
                            style={{
                                height:
                                    peak > 0 && week.total > 0
                                        ? `${Math.max(4, (week.total / peak) * 100)}%`
                                        : '4%',
                            }}
                        />
                    </div>
                </Tooltip>
            ))}
        </div>
    );
}

const CHART_WIDTH = 1000;
const CHART_HEIGHT = 112;

function CumulativeChart({
    weeks,
    metric,
    onHover,
}: {
    weeks: readonly HeatmapWeek[];
    metric: UsageMetric;
    onHover: (target: HoverTarget | undefined) => void;
}) {
    const { t } = useTranslation();
    const points = useMemo(() => buildCumulative(weeks), [weeks]);
    const total = points.at(-1)?.total ?? 0;
    const step = CHART_WIDTH / Math.max(1, points.length - 1);
    const y = (value: number) =>
        total > 0 ? CHART_HEIGHT - (value / total) * (CHART_HEIGHT - 4) : CHART_HEIGHT;
    const line = points
        .map(
            (point, index) =>
                `${index === 0 ? 'M' : 'L'}${(index * step).toFixed(1)},${y(point.total).toFixed(1)}`,
        )
        .join(' ');
    return (
        <svg
            aria-hidden="true"
            className="block h-28 w-full"
            preserveAspectRatio="none"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            onPointerMove={(event) => {
                const bounds = event.currentTarget.getBoundingClientRect();
                const index = Math.round(
                    ((event.clientX - bounds.left) / bounds.width) * (points.length - 1),
                );
                const point = points.at(Math.min(points.length - 1, Math.max(0, index)));
                if (point)
                    onHover({
                        label: t('usage.activity.through', { date: formatDate(t, point.date) }),
                        detail: formatMetric(t, point.total, metric),
                    });
            }}
        >
            <path
                className="fill-chart/15"
                d={`${line} L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`}
            />
            <path
                className="fill-none stroke-chart"
                d={line}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

/**
 * Token or cost activity over the trailing year: a GitHub-style day grid, weekly bars, or the running total. Day cells
 * and week bars carry their figures in a Tooltip; the continuous cumulative line has no discrete target, so it reports
 * the hovered week in the caption under the chart instead of the summary. The Tokens/Cost switch lives here, beside the
 * view switch, because nothing else on the page follows it. The chart is one `img` whose name is the year's summary
 * plus its busiest day, so a keyboard or screen-reader user gets the reading without stepping through 365 cells.
 */
export function UsageActivityCard({
    activity,
    today,
}: {
    activity: readonly UsageDay[];
    today: string;
}) {
    const { t } = useTranslation();
    const [view, setView] = useState<ActivityView>('daily');
    const [metric, setMetric] = useState<UsageMetric>('tokens');
    const [hover, setHover] = useState<HoverTarget>();
    const weeks = useMemo(
        () => buildHeatmap(t, activity, today, metric),
        [t, activity, today, metric],
    );
    const days = useMemo(() => new Map(activity.map((day) => [day.date, day])), [activity]);
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

    return (
        <section
            // `min-w-0` lets the page grid shrink this card to the pane, so the year chart scrolls inside it instead of
            // widening the whole page past a narrow pane.
            className="min-w-0 rounded-md border border-border bg-surface p-4"
            aria-label={activityCardLabel(t, metric)}
        >
            {/* Wraps so a narrow pane drops the switches under the title instead of clipping them. */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                {/*
                 * The range selector does not apply here: the chart always covers the trailing year, and the caption
                 * says so, since a 30D selection above a year-long chart otherwise reads as a bug.
                 */}
                <h2 className="m-0 flex items-baseline gap-2 text-[13px] font-semibold">
                    {t('usage.activity.title')}
                    <span className="text-[11px] font-normal text-muted">
                        {t('usage.activity.caption')}
                    </span>
                </h2>
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <ToggleGroup
                        aria-label={t('usage.activity.metric')}
                        value={[metric]}
                        onValueChange={(next: UsageMetric[]) => {
                            if (next[0]) setMetric(next[0]);
                        }}
                    >
                        <ToggleGroupItem value="tokens">{t('usage.tokens')}</ToggleGroupItem>
                        <ToggleGroupItem value="cost">{t('usage.cost.title')}</ToggleGroupItem>
                    </ToggleGroup>
                    <ToggleGroup
                        aria-label={t('usage.activity.view')}
                        value={[view]}
                        onValueChange={(next: ActivityView[]) => {
                            if (next[0]) setView(next[0]);
                        }}
                    >
                        {ACTIVITY_VIEWS.map((item) => (
                            <ToggleGroupItem key={item} value={item}>
                                {t(`usage.activity.views.${item}`)}
                            </ToggleGroupItem>
                        ))}
                    </ToggleGroup>
                </div>
            </div>
            <div
                className="mt-3 overflow-x-auto rounded-sm focus-visible:outline focus-visible:outline-accent"
                role="img"
                aria-label={chartLabel}
                tabIndex={0}
            >
                <div className="flex min-w-160 gap-2" onPointerLeave={() => setHover(undefined)}>
                    {view === 'daily' && (
                        <div
                            className="grid grid-rows-7 gap-0.5 pt-4 text-[11px] text-muted"
                            aria-hidden="true"
                        >
                            {WEEKDAY_LABELS.map((label, index) => (
                                <span key={index} className="flex items-center leading-none">
                                    {label ? t(label) : ''}
                                </span>
                            ))}
                        </div>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        {view !== 'cumulative' && <MonthLabels weeks={weeks} />}
                        {view === 'daily' && <DailyGrid weeks={weeks} days={days} />}
                        {view === 'weekly' && <WeeklyBars weeks={weeks} metric={metric} />}
                        {view === 'cumulative' && (
                            <CumulativeChart weeks={weeks} metric={metric} onHover={setHover} />
                        )}
                    </div>
                </div>
            </div>
            <div className="mt-3 flex min-h-5 items-center justify-between gap-3 text-[11px] text-muted">
                {/* Not a live region: it changes on every pointer move, and the chart's own label carries the summary. */}
                <span className="truncate">
                    {hover ? (
                        <>
                            <span className="text-foreground">{hover.label}</span> · {hover.detail}
                        </>
                    ) : (
                        summary
                    )}
                </span>
                {view === 'daily' && (
                    <span className="flex flex-none items-center gap-1" aria-hidden="true">
                        {t('usage.activity.less')}
                        {LEVEL_CLASSES.map((level) => (
                            <span key={level} className={cn('size-2.5 rounded-sm', level)} />
                        ))}
                        {t('usage.activity.more')}
                    </span>
                )}
            </div>
        </section>
    );
}
