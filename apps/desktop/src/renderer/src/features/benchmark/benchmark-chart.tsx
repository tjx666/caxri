import type { BenchmarkCatalog } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

import { useContainerWidth } from '../../hooks/use-container-width';
import { useTranslation } from '../../i18n';
import type { PlacedPoint } from './benchmark-chart-layout';
import { CHART_MARGIN, layoutChart } from './benchmark-chart-layout';
import type { MarkerShape } from './benchmark-presentation';
import {
    formatTick,
    markerShape,
    metricLabel,
    modelLabel,
    qualityLabel,
    seriesColor,
} from './benchmark-presentation';
import type { ChartModel, ChartPoint, QualitySource } from './benchmark-results';
import { isHigherBetter } from './benchmark-results';

const CHART_HEIGHT = 380;
/**
 * Average advance of an 11px UI glyph, for placing labels before they render; close enough to keep them apart.
 */
const LABEL_CHAR_WIDTH = 6.2;
const EFFORT_CHAR_WIDTH = 5.4;

function Marker({
    shape,
    cx,
    cy,
    size,
    color,
}: {
    shape: MarkerShape;
    cx: number;
    cy: number;
    size: number;
    color: string;
}) {
    if (shape === 'square')
        return (
            <rect
                fill={color}
                height={size * 1.7}
                rx={1.5}
                width={size * 1.7}
                x={cx - size * 0.85}
                y={cy - size * 0.85}
            />
        );
    if (shape === 'diamond')
        return (
            <path
                d={`M ${cx} ${cy - size * 1.15} L ${cx + size * 1.15} ${cy} L ${cx} ${cy + size * 1.15} L ${cx - size * 1.15} ${cy} Z`}
                fill={color}
            />
        );
    return <circle cx={cx} cy={cy} fill={color} r={size} />;
}

function PointLabel({ point, name }: { point: PlacedPoint; name: string }) {
    return (
        <text
            className="fill-foreground text-[11px]"
            textAnchor={point.labelAnchor}
            x={point.labelX}
            y={point.labelY}
        >
            {name}
            {point.entry.effort && (
                <tspan className="fill-muted text-[10px] tracking-[0.06em] uppercase" dx={4}>
                    {point.entry.effort}
                </tspan>
            )}
        </text>
    );
}

/**
 * The result chart, after the DeepSWE leaderboard: quality up, the chosen cost-like metric decreasing to the right, one
 * point per Entry, and one model's efforts joined by a line. Points on the efficient frontier carry a ring.
 */
export function BenchmarkChart({
    chart,
    catalog,
    source,
    highlighted,
    onHighlight,
}: {
    chart: ChartModel;
    catalog: BenchmarkCatalog | undefined;
    source: QualitySource;
    highlighted: number | undefined;
    onHighlight: (entryIndex: number | undefined) => void;
}) {
    const { t } = useTranslation();
    const [reference, width] = useContainerWidth<HTMLDivElement>();
    const nameOf = (point: Pick<ChartPoint, 'entry'>) => modelLabel(catalog, point.entry);
    const layout = layoutChart(
        chart,
        width,
        CHART_HEIGHT,
        (point) =>
            nameOf(point).length * LABEL_CHAR_WIDTH +
            (point.entry.effort ? 4 + point.entry.effort.length * EFFORT_CHAR_WIDTH : 0),
    );
    const { plot } = layout;
    const byEntry = new Map(layout.points.map((point) => [point.entryIndex, point]));
    const yTitle =
        chart.y === 'quality' ? qualityLabel(t, source) : t('benchmark.chart.timeFaster');
    const xTitle = t(
        isHigherBetter(chart.x) ? 'benchmark.chart.xTitleMore' : 'benchmark.chart.xTitle',
        {
            metric: metricLabel(t, chart.x),
        },
    );
    return (
        <div ref={reference} className="relative w-full" data-benchmark-chart>
            {width > 0 && (
                <svg
                    aria-label={t('benchmark.chart.label', {
                        y: yTitle,
                        x: metricLabel(t, chart.x),
                    })}
                    className="block"
                    height={CHART_HEIGHT}
                    role="img"
                    width={width}
                >
                    {layout.yTicks.map((tick) => (
                        <g key={`y-${tick.value}`}>
                            <line
                                className="stroke-border"
                                strokeDasharray="2 3"
                                x1={plot.left}
                                x2={plot.right}
                                y1={tick.position}
                                y2={tick.position}
                            />
                            <text
                                className="fill-muted text-[11px] tabular-nums"
                                textAnchor="end"
                                x={plot.left - 8}
                                y={tick.position + 3}
                            >
                                {formatTick(chart.y, tick.value)}
                            </text>
                        </g>
                    ))}
                    {layout.xTicks.map((tick) => (
                        <g key={`x-${tick.value}`}>
                            <line
                                className="stroke-border"
                                strokeDasharray="2 3"
                                x1={tick.position}
                                x2={tick.position}
                                y1={plot.top}
                                y2={plot.bottom}
                            />
                            <text
                                className="fill-muted text-[11px] tabular-nums"
                                textAnchor="middle"
                                x={tick.position}
                                y={plot.bottom + 14}
                            >
                                {formatTick(chart.x, tick.value)}
                            </text>
                        </g>
                    ))}
                    <line
                        className="stroke-border"
                        x1={plot.left}
                        x2={plot.right}
                        y1={plot.bottom}
                        y2={plot.bottom}
                    />
                    <line
                        className="stroke-border"
                        x1={plot.left}
                        x2={plot.left}
                        y1={plot.top}
                        y2={plot.bottom}
                    />
                    <text
                        className="fill-muted text-[11px]"
                        textAnchor="end"
                        x={plot.right}
                        y={plot.top - 10}
                    >
                        {t('benchmark.chart.mostEfficient')}
                    </text>
                    <text className="fill-muted text-[11px]" x={plot.left} y={plot.top - 10}>
                        {yTitle}
                    </text>
                    <text
                        className="fill-muted text-[11px]"
                        textAnchor="middle"
                        x={(plot.left + plot.right) / 2}
                        y={CHART_HEIGHT - CHART_MARGIN.bottom + 34}
                    >
                        {xTitle}
                    </text>
                    {chart.series.map((series) => (
                        <polyline
                            key={series.key}
                            fill="none"
                            opacity={
                                highlighted === undefined ||
                                series.points.some((point) => point.entryIndex === highlighted)
                                    ? 0.7
                                    : 0.2
                            }
                            points={series.points
                                .map((point) => byEntry.get(point.entryIndex))
                                .filter((point) => point !== undefined)
                                .map((point) => `${point.cx},${point.cy}`)
                                .join(' ')}
                            stroke={seriesColor(series.entry.provider)}
                            strokeWidth={1.5}
                        />
                    ))}
                    {layout.points.map((point) => {
                        const isDimmed =
                            highlighted !== undefined && highlighted !== point.entryIndex;
                        const name = nameOf(point);
                        return (
                            <g
                                key={point.entryIndex}
                                aria-label={t('benchmark.chart.pointLabel', {
                                    agent: agentProviderCatalog[point.entry.provider].displayName,
                                    model: name,
                                    effort:
                                        point.entry.effort ?? t('benchmark.picker.defaultEffort'),
                                })}
                                className="cursor-default transition-opacity"
                                data-benchmark-point={point.entryIndex}
                                opacity={isDimmed ? 0.35 : 1}
                                role="img"
                                onPointerEnter={() => onHighlight(point.entryIndex)}
                                onPointerLeave={() => onHighlight(undefined)}
                            >
                                {point.isFrontier && (
                                    <circle
                                        className="fill-none stroke-foreground/50"
                                        cx={point.cx}
                                        cy={point.cy}
                                        r={9}
                                        strokeWidth={1}
                                    />
                                )}
                                <Marker
                                    color={seriesColor(point.entry.provider)}
                                    cx={point.cx}
                                    cy={point.cy}
                                    shape={markerShape(point.entry.provider)}
                                    size={highlighted === point.entryIndex ? 6 : 5}
                                />
                                <PointLabel name={name} point={point} />
                            </g>
                        );
                    })}
                </svg>
            )}
        </div>
    );
}
