import { omit } from 'es-toolkit';

import type { ChartModel, ChartPoint } from './benchmark-results';
import { isHigherBetter, niceScale } from './benchmark-results';

export const CHART_MARGIN = { top: 28, right: 28, bottom: 44, left: 52 } as const;

/**
 * Space kept between a plot edge and the nearest point, so a point on the domain boundary is not clipped in half.
 */
const PLOT_INSET = 14;
const LABEL_HEIGHT = 14;

/**
 * Average advance of an 11px UI glyph, for placing labels before they render; close enough to keep them apart.
 */
const LABEL_CHAR_WIDTH = 6.2;
const EFFORT_CHAR_WIDTH = 5.4;

/**
 * The width a point's label (model name plus optional effort tag) is expected to take, for {@link layoutChart}'s overlap
 * avoidance. Shared by the on-screen chart and the share card so both place labels alike.
 */
export function estimatePointLabelWidth(name: string, effort: string | undefined): number {
    return name.length * LABEL_CHAR_WIDTH + (effort ? 4 + effort.length * EFFORT_CHAR_WIDTH : 0);
}

interface Tick {
    value: number;
    position: number;
}

export interface PlacedPoint extends ChartPoint {
    cx: number;
    cy: number;
    /**
     * Where the label's baseline starts, nudged down past an earlier label it would overlap.
     */
    labelX: number;
    labelY: number;
    labelAnchor: 'start' | 'end';
}

export interface ChartLayout {
    width: number;
    height: number;
    plot: { left: number; top: number; right: number; bottom: number };
    xTicks: Tick[];
    yTicks: Tick[];
    points: PlacedPoint[];
}

/**
 * Pixel positions for a chart. A horizontal metric where lower is better (cost, time) runs high to low, and one where
 * higher is better (tokens per second) runs low to high, so the best point always sits on the right; quality runs up,
 * and time, when it is the vertical axis, runs down so faster is higher. The top-right corner is therefore always the
 * most efficient.
 */
export function layoutChart(
    chart: ChartModel,
    width: number,
    height: number,
    estimateLabelWidth: (point: ChartPoint) => number,
): ChartLayout {
    const plot = {
        left: CHART_MARGIN.left,
        top: CHART_MARGIN.top,
        right: Math.max(CHART_MARGIN.left + 1, width - CHART_MARGIN.right),
        bottom: Math.max(CHART_MARGIN.top + 1, height - CHART_MARGIN.bottom),
    };
    const xs = chart.points.map((point) => point.x);
    const ys = chart.points.map((point) => point.y);
    const xScale = niceScale(Math.min(0, ...xs), Math.max(...xs, 0));
    const yScale =
        chart.y === 'quality'
            ? clampQuality(niceScale(Math.min(...ys), Math.max(...ys)))
            : niceScale(Math.min(0, ...ys), Math.max(...ys, 0));
    const innerLeft = plot.left + PLOT_INSET;
    const innerRight = plot.right - PLOT_INSET;
    const innerTop = plot.top + PLOT_INSET;
    const innerBottom = plot.bottom - PLOT_INSET;
    const span = (domain: [number, number]) => domain[1] - domain[0] || 1;
    const isXAscending = isHigherBetter(chart.x);
    const xPosition = (value: number) =>
        innerLeft +
        ((isXAscending ? value - xScale.domain[0] : xScale.domain[1] - value) /
            span(xScale.domain)) *
            (innerRight - innerLeft);
    /**
     * Quality grows upward; time grows downward so that faster is higher, like better quality.
     */
    const yPosition = (value: number) =>
        innerTop +
        ((chart.y === 'quality' ? yScale.domain[1] - value : value - yScale.domain[0]) /
            span(yScale.domain)) *
            (innerBottom - innerTop);
    const placed = chart.points.map((point) => {
        const cx = xPosition(point.x);
        const cy = yPosition(point.y);
        // Labels sit to the right of their point unless that would run past the plot, as the best points do.
        const labelWidth = estimateLabelWidth(point);
        const labelAnchor: PlacedPoint['labelAnchor'] =
            cx + 10 + labelWidth > plot.right ? 'end' : 'start';
        return {
            ...point,
            cx,
            cy,
            labelX: labelAnchor === 'start' ? cx + 10 : cx - 10,
            labelY: cy + 4,
            labelAnchor,
            labelWidth,
        };
    });
    // Top to bottom, push a label down while it overlaps one already placed.
    const order = placed.toSorted((left, right) => left.labelY - right.labelY);
    const boxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
    for (const point of order) {
        const horizontal = (left: number) => ({ left, right: left + point.labelWidth });
        const { left, right } = horizontal(
            point.labelAnchor === 'start' ? point.labelX : point.labelX - point.labelWidth,
        );
        let top = point.labelY - LABEL_HEIGHT + 3;
        for (const box of boxes)
            if (
                left < box.right &&
                right > box.left &&
                top < box.bottom &&
                top + LABEL_HEIGHT > box.top
            )
                top = box.bottom;
        point.labelY = top + LABEL_HEIGHT - 3;
        boxes.push({ left, right, top, bottom: top + LABEL_HEIGHT });
    }
    return {
        width,
        height,
        plot,
        xTicks: xScale.ticks.map((value) => ({ value, position: xPosition(value) })),
        yTicks: yScale.ticks.map((value) => ({ value, position: yPosition(value) })),
        points: placed.map((point) => omit(point, ['labelWidth'])),
    };
}

function clampQuality(scale: { domain: [number, number]; ticks: number[] }) {
    const low = Math.max(0, scale.domain[0]);
    const high = Math.min(100, scale.domain[1]);
    return {
        domain: [low, high] as [number, number],
        ticks: scale.ticks.filter((tick) => tick >= low && tick <= high),
    };
}
