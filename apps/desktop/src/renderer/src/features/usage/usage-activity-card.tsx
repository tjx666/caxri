import { useMemo, useState } from 'react';

import type { UsageDay } from '@caxri/protocol';
import { formatDuration, formatTokens, formatUsd, shiftLocalDate } from '@caxri/protocol';

import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { cn } from '../../lib/utilities';
import type { HeatmapWeek, UsageMetric } from './usage-metrics';
import { buildCumulative, buildHeatmap, formatDate, formatMetric } from './usage-metrics';

type ActivityView = 'daily' | 'weekly' | 'cumulative';

const ACTIVITY_VIEWS: ReadonlyArray<{ value: ActivityView; label: string }> = [
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'cumulative', label: 'Cumulative' },
];

/**
 * Intensity steps over the `--success` role, GitHub style. Level 0 is an empty day on the card's own elevated fill.
 */
const LEVEL_CLASSES = [
    'bg-elevated',
    'bg-success/25',
    'bg-success/50',
    'bg-success/75',
    'bg-success',
];
const WEEKDAY_LABELS = ['', 'Mon', '', 'Wed', '', 'Fri', ''];

interface HoverTarget {
    label: string;
    detail: string;
}

function dayDetail(day: UsageDay | undefined): string {
    if (!day || day.tokens === 0) return 'No usage';
    return `${formatTokens(day.tokens)} tokens · ${formatUsd(day.costUsd)} · ${formatDuration(day.activeMs)} active`;
}

function MonthLabels({ weeks }: { weeks: readonly HeatmapWeek[] }) {
    return (
        <div className="grid grid-cols-[repeat(53,minmax(0,1fr))] gap-0.5" aria-hidden="true">
            {weeks.map((week) => (
                <span
                    key={week.start}
                    className="overflow-visible text-[10px] whitespace-nowrap text-muted"
                >
                    {week.monthLabel ?? ''}
                </span>
            ))}
        </div>
    );
}

function DailyGrid({
    weeks,
    onHover,
    days,
}: {
    weeks: readonly HeatmapWeek[];
    onHover: (target: HoverTarget | undefined) => void;
    days: ReadonlyMap<string, UsageDay>;
}) {
    return (
        <div className="grid grid-cols-[repeat(53,minmax(0,1fr))] gap-0.5">
            {weeks.map((week) => (
                <div key={week.start} className="grid grid-rows-7 gap-0.5">
                    {week.cells.map((cell) => (
                        <div
                            key={cell.date}
                            className={cn(
                                'aspect-square rounded-sm',
                                cell.isFuture ? 'bg-transparent' : LEVEL_CLASSES[cell.level],
                            )}
                            onPointerEnter={
                                cell.isFuture
                                    ? undefined
                                    : () =>
                                          onHover({
                                              label: formatDate(cell.date),
                                              detail: dayDetail(days.get(cell.date)),
                                          })
                            }
                        />
                    ))}
                </div>
            ))}
        </div>
    );
}

function WeeklyBars({
    weeks,
    metric,
    onHover,
}: {
    weeks: readonly HeatmapWeek[];
    metric: UsageMetric;
    onHover: (target: HoverTarget | undefined) => void;
}) {
    const peak = Math.max(0, ...weeks.map((week) => week.total));
    return (
        <div className="grid h-28 grid-cols-[repeat(53,minmax(0,1fr))] items-end gap-0.5">
            {weeks.map((week) => (
                <div
                    key={week.start}
                    className="flex h-full items-end"
                    onPointerEnter={() =>
                        onHover({
                            label: `Week of ${formatDate(week.start)}`,
                            detail: week.total > 0 ? formatMetric(week.total, metric) : 'No usage',
                        })
                    }
                >
                    <div
                        className={cn(
                            'w-full rounded-sm',
                            week.total > 0 ? LEVEL_CLASSES[Math.max(1, week.level)] : 'bg-elevated',
                        )}
                        style={{
                            height:
                                peak > 0 && week.total > 0
                                    ? `${Math.max(4, (week.total / peak) * 100)}%`
                                    : '4%',
                        }}
                    />
                </div>
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
                        label: `Through ${formatDate(point.date)}`,
                        detail: formatMetric(point.total, metric),
                    });
            }}
        >
            <path
                className="fill-success/15"
                d={`${line} L${CHART_WIDTH},${CHART_HEIGHT} L0,${CHART_HEIGHT} Z`}
            />
            <path
                className="fill-none stroke-success"
                d={line}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
            />
        </svg>
    );
}

/**
 * Token activity over the trailing year: a GitHub-style day grid, weekly bars, or the running total. The hover caption
 * is the text twin of the color scale; the summary line stays readable without a pointer.
 */
export function UsageActivityCard({
    activity,
    today,
    metric,
}: {
    activity: readonly UsageDay[];
    today: string;
    metric: UsageMetric;
}) {
    const [view, setView] = useState<ActivityView>('daily');
    const [hover, setHover] = useState<HoverTarget>();
    const weeks = useMemo(() => buildHeatmap(activity, today, metric), [activity, today, metric]);
    const days = useMemo(() => new Map(activity.map((day) => [day.date, day])), [activity]);
    const yearStart = shiftLocalDate(today, -364);
    const yearDays = activity.filter((day) => day.date >= yearStart);
    const yearTotal = yearDays.reduce(
        (sum, day) => sum + (metric === 'tokens' ? day.tokens : day.costUsd),
        0,
    );
    const activeDays = yearDays.filter((day) => day.tokens > 0).length;
    const summary = `${formatMetric(yearTotal, metric)} over ${activeDays} active ${activeDays === 1 ? 'day' : 'days'} in the last year`;

    return (
        <section
            className="rounded-md border border-border bg-surface p-4"
            aria-label="Token activity"
        >
            <div className="flex items-center justify-between gap-3">
                <h2 className="m-0 text-[13px] font-semibold">Activity</h2>
                <ToggleGroup
                    aria-label="Activity view"
                    value={[view]}
                    onValueChange={(next: ActivityView[]) => {
                        if (next[0]) setView(next[0]);
                    }}
                >
                    {ACTIVITY_VIEWS.map((item) => (
                        <ToggleGroupItem key={item.value} value={item.value}>
                            {item.label}
                        </ToggleGroupItem>
                    ))}
                </ToggleGroup>
            </div>
            <div className="mt-3 overflow-x-auto" role="img" aria-label={summary}>
                <div className="flex min-w-160 gap-2" onPointerLeave={() => setHover(undefined)}>
                    {view === 'daily' && (
                        <div
                            className="grid grid-rows-7 gap-0.5 pt-4 text-[10px] text-muted"
                            aria-hidden="true"
                        >
                            {WEEKDAY_LABELS.map((label, index) => (
                                <span key={index} className="flex items-center leading-none">
                                    {label}
                                </span>
                            ))}
                        </div>
                    )}
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                        {view !== 'cumulative' && <MonthLabels weeks={weeks} />}
                        {view === 'daily' && (
                            <DailyGrid weeks={weeks} days={days} onHover={setHover} />
                        )}
                        {view === 'weekly' && (
                            <WeeklyBars weeks={weeks} metric={metric} onHover={setHover} />
                        )}
                        {view === 'cumulative' && (
                            <CumulativeChart weeks={weeks} metric={metric} onHover={setHover} />
                        )}
                    </div>
                </div>
            </div>
            <div className="mt-3 flex min-h-5 items-center justify-between gap-3 text-[11px] text-muted">
                <span aria-live="polite" className="truncate">
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
                        Less
                        {LEVEL_CLASSES.map((level) => (
                            <span key={level} className={cn('size-2.5 rounded-sm', level)} />
                        ))}
                        More
                    </span>
                )}
            </div>
        </section>
    );
}
