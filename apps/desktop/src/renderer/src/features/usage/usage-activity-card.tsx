import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { UsageDay } from '@caxri/protocol';

import { HorizontalScrollArea } from '../../components/scroll-fade';
import { ToggleGroup, ToggleGroupItem } from '../../components/ui/toggle-group';
import { Tooltip } from '../../components/ui/tooltip';
import type { TranslationKey } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { ActivityHoverTarget, ActivityView } from './usage-activity';
import {
    ACTIVITY_VIEWS,
    activityCursorLayout,
    activityCursorText,
    activityYearSummary,
    cumulativeTarget,
} from './usage-activity';
import type { EndPin } from './usage-activity-scroll';
import { attachEndPin } from './usage-activity-scroll';
import { CHART_CURSOR_CLASS } from './usage-chart-cursor';
import type { CumulativePoint, HeatmapWeek, UsageMetric } from './usage-metrics';
import {
    activityCardLabel,
    buildCumulative,
    buildHeatmap,
    usageDayTooltip,
    usageWeekTooltip,
} from './usage-metrics';
import { useChartKeyboardCursor } from './use-chart-keyboard-cursor';

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

/**
 * Scrolls the keyboard cursor's item into the chart's horizontal scroller: on a narrow pane the year grid overflows,
 * and the cursor would otherwise ring a day the user cannot see.
 */
const revealCursor = (element: HTMLElement | null): void => {
    element?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
};

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
    cursorDate,
}: {
    weeks: readonly HeatmapWeek[];
    days: ReadonlyMap<string, UsageDay>;
    cursorDate: string | undefined;
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
                                    ref={cell.date === cursorDate ? revealCursor : undefined}
                                    className={cn(
                                        'aspect-square rounded-sm',
                                        LEVEL_CLASSES[cell.level],
                                        cell.date === cursorDate && CHART_CURSOR_CLASS,
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

function WeeklyBars({
    weeks,
    metric,
    cursorWeek,
}: {
    weeks: readonly HeatmapWeek[];
    metric: UsageMetric;
    cursorWeek: number | undefined;
}) {
    const { t } = useTranslation();
    const peak = Math.max(0, ...weeks.map((week) => week.total));
    return (
        <div className="grid h-28 grid-cols-[repeat(53,minmax(0,1fr))] items-end gap-0.5">
            {/* The full-height column is the trigger, so a short week's bar is as easy to hover as the peak. */}
            {weeks.map((week, index) => (
                <Tooltip key={week.start} content={usageWeekTooltip(t, week, metric)}>
                    <div
                        ref={index === cursorWeek ? revealCursor : undefined}
                        className={cn(
                            'flex h-full items-end rounded-sm',
                            index === cursorWeek && CHART_CURSOR_CLASS,
                        )}
                    >
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
    points,
    metric,
    cursorIndex,
    onHover,
}: {
    points: readonly CumulativePoint[];
    metric: UsageMetric;
    cursorIndex: number | undefined;
    onHover: (target: ActivityHoverTarget | undefined) => void;
}) {
    const { t } = useTranslation();
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
                if (point) onHover(cumulativeTarget(t, point, metric));
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
            {cursorIndex !== undefined && (
                <line
                    className="stroke-accent"
                    strokeWidth={1}
                    vectorEffect="non-scaling-stroke"
                    x1={cursorIndex * step}
                    x2={cursorIndex * step}
                    y1={0}
                    y2={CHART_HEIGHT}
                />
            )}
        </svg>
    );
}

/**
 * Token or cost activity over the trailing year: a GitHub-style day grid, weekly bars, or the running total. Day cells
 * and week bars carry their figures in a Tooltip; the continuous cumulative line has no discrete target, so it reports
 * the hovered week in the caption under the chart instead of the summary. The Tokens/Cost switch lives here, beside the
 * view switch, because nothing else on the page follows it. The chart is one `img` whose name is the year's summary
 * plus its busiest day, so a keyboard or screen-reader user gets the reading without stepping through 365 cells; the
 * arrow keys then step through days, weeks, or points (`usage-chart-cursor.ts`), ringing the item and showing its
 * Tooltip text in the caption, announced through a polite live region.
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
    const [hover, setHover] = useState<ActivityHoverTarget>();
    const chartReference = useRef<HTMLDivElement>(null);
    const endPinReference = useRef<EndPin>(undefined);
    /**
     * The chart runs oldest to newest, so a pane narrower than the year stays on the newest weeks, also when the pane
     * narrows after mount, until the user scrolls away. Each view lays out anew, so a view switch re-pins.
     */
    useLayoutEffect(() => {
        const chart = chartReference.current;
        if (!chart) return;
        const pin = attachEndPin(chart);
        endPinReference.current = pin;
        return () => {
            pin.dispose();
            endPinReference.current = undefined;
        };
    }, []);
    useLayoutEffect(() => {
        endPinReference.current?.repin();
    }, [view]);
    const weeks = useMemo(
        () => buildHeatmap(t, activity, today, metric),
        [t, activity, today, metric],
    );
    const days = useMemo(() => new Map(activity.map((day) => [day.date, day])), [activity]);
    const points = useMemo(() => buildCumulative(weeks), [weeks]);
    const keyboard = useChartKeyboardCursor(
        activityCursorLayout(view, weeks.length, points.length),
        view,
    );
    const cursor = keyboard.cursor;
    const cursorText = activityCursorText(t, { cursor, days, metric, points, view, weeks });
    const { summary, chartLabel } = activityYearSummary(t, activity, today, metric);

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
            {/* Fades the older weeks' edge while the chart sits pinned to the newest ones in a narrow pane. */}
            <HorizontalScrollArea
                scrollReference={chartReference}
                className="mt-3"
                scrollClassName="rounded-sm focus-visible:outline focus-visible:outline-accent"
                role="img"
                aria-label={chartLabel}
                tabIndex={0}
                onBlur={keyboard.onBlur}
                onKeyDown={(event) => {
                    // The key takes the readout back from the pointer until the pointer moves again.
                    setHover(undefined);
                    keyboard.onKeyDown(event);
                }}
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
                        {view === 'daily' && (
                            <DailyGrid
                                weeks={weeks}
                                days={days}
                                cursorDate={cursor === undefined ? undefined : points[cursor].date}
                            />
                        )}
                        {view === 'weekly' && (
                            <WeeklyBars weeks={weeks} metric={metric} cursorWeek={cursor} />
                        )}
                        {view === 'cumulative' && (
                            <CumulativeChart
                                points={points}
                                metric={metric}
                                cursorIndex={cursor}
                                onHover={setHover}
                            />
                        )}
                    </div>
                </div>
            </HorizontalScrollArea>
            {/* Wraps so a narrow pane puts the legend under the summary instead of clipping the summary. */}
            <div className="mt-3 flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted">
                {/* Not a live region: it changes on every pointer move, and the chart's own label carries the summary. */}
                <span className="min-w-0">
                    {hover ? (
                        <>
                            <span className="text-foreground">{hover.label}</span> · {hover.detail}
                        </>
                    ) : (
                        (cursorText ?? summary)
                    )}
                </span>
                {/* Only keyboard steps are announced; pointer moves would flood the live region. */}
                <span className="sr-only" aria-live="polite">
                    {cursorText}
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
