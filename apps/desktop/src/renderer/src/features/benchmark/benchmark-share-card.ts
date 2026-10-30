import type { AgentProvider, BenchmarkEntry, BenchmarkRun } from '@caxri/protocol';
import { formatUsd } from '@caxri/protocol';

import type { PlacedPoint } from './benchmark-chart-layout';
import { estimatePointLabelWidth, layoutChart } from './benchmark-chart-layout';
import type { MarkerShape } from './benchmark-presentation';
import { formatLatency, formatPercent, formatTick, markerShape } from './benchmark-presentation';
import type { ChartModel, ConfigResult, QualitySource } from './benchmark-results';

/**
 * Logical width of the share card in CSS pixels. The raster is this times the export scale, so the card keeps one
 * proportion on every screen.
 */
export const SHARE_CARD_WIDTH = 960;

/**
 * How many leaderboard rows the card shows. A card that lists every Entry of a large run stops being glanceable.
 */
export const SHARE_CARD_TOP_COUNT = 5;

/**
 * Export scale for crisp text on a retina display or in a social feed.
 */
export const SHARE_CARD_SCALE = 2;

const PADDING = 32;
const HEADER_HEIGHT = 84;
const CHART_HEIGHT = 340;
const TABLE_HEAD_HEIGHT = 30;
const ROW_HEIGHT = 30;
const FOOTER_HEIGHT = 52;
const TITLE_MAX_CHARACTERS = 62;
const NAME_MAX_CHARACTERS = 34;

/**
 * Resolved colors and font for one card. They are concrete values, not CSS variables, because the card is rasterized
 * from a standalone SVG image that cannot see the page's stylesheet.
 */
export interface ShareCardPalette {
    background: string;
    border: string;
    fontFamily: string;
    foreground: string;
    muted: string;
    series: Record<AgentProvider, string>;
}

interface ShareCardRow {
    cost: string;
    entry: BenchmarkEntry;
    name: string;
    quality: string | undefined;
    rank: number;
    time: string;
    y: number;
}

export interface ShareCardModel {
    chart: {
        layout: ReturnType<typeof layoutChart>;
        mostEfficient: string;
        /**
         * The laid-out points with the display name their label shows.
         */
        points: Array<PlacedPoint & { name: string }>;
        xMetric: ChartModel['x'];
        yMetric: ChartModel['y'];
        series: Array<{ key: string; entry: BenchmarkEntry; points: string[] }>;
        xTitle: string;
        yTitle: string;
        top: number;
    };
    footer: { madeWith: string; y: number };
    headers: { cost: string; quality: string | undefined; time: string; y: number };
    height: number;
    rows: ShareCardRow[];
    subtitle: string;
    title: string;
    width: number;
}

export interface ShareCardInput {
    chart: ChartModel;
    /**
     * Pre-translated strings, so this module stays free of the i18n runtime.
     */
    text: {
        cost: string;
        madeWith: string;
        mostEfficient: string;
        quality: string;
        subtitle: string;
        time: string;
        xTitle: string;
        yTitle: string;
    };
    nameOf: (entry: BenchmarkEntry) => string;
    ranked: readonly ConfigResult[];
    source: QualitySource;
    title: string;
    topCount?: number;
}

/**
 * Cuts text to `maxCharacters`, ending in an ellipsis. SVG text does not wrap, so a long prompt summary or model name
 * has to be shortened before it is drawn or it runs off the card.
 */
export function truncateForCard(text: string, maxCharacters: number): string {
    const collapsed = text.replaceAll(/\s+/gu, ' ').trim();
    const characters = [...collapsed];
    if (characters.length <= maxCharacters) return collapsed;
    return `${characters
        .slice(0, Math.max(1, maxCharacters - 1))
        .join('')
        .trimEnd()}…`;
}

function qualityText(result: ConfigResult, source: QualitySource): string | undefined {
    if (source === 'judge')
        return result.score === undefined ? '–' : String(Math.round(result.score));
    if (source === 'check')
        return result.checkPassRate === undefined ? '–' : formatPercent(result.checkPassRate);
    return undefined;
}

/**
 * Shapes one run into what the card draws: the truncated title, the laid-out scatter chart, and the leading rows of the
 * leaderboard with their figures already formatted. Pure, so the card's content can be tested without a DOM.
 */
export function buildShareCard(input: ShareCardInput): ShareCardModel {
    const { chart, nameOf, ranked, source, text } = input;
    const topCount = input.topCount ?? SHARE_CARD_TOP_COUNT;
    const innerWidth = SHARE_CARD_WIDTH - PADDING * 2;
    const layout = layoutChart(chart, innerWidth, CHART_HEIGHT, (point) =>
        estimatePointLabelWidth(nameOf(point.entry), point.entry.effort),
    );
    const byEntry = new Map(layout.points.map((point: PlacedPoint) => [point.entryIndex, point]));
    const chartTop = HEADER_HEIGHT;
    const headersY = chartTop + CHART_HEIGHT + 24;
    const shown = ranked.filter((result) => result.completed > 0).slice(0, topCount);
    const rows = shown.map<ShareCardRow>((result, index) => ({
        cost: result.costUsd === undefined ? '–' : formatUsd(result.costUsd),
        entry: result.entry,
        name: truncateForCard(
            `${nameOf(result.entry)}${result.entry.effort ? ` ${result.entry.effort}` : ''}`,
            NAME_MAX_CHARACTERS,
        ),
        quality: qualityText(result, source),
        rank: index + 1,
        time: result.durationMs === undefined ? '–' : formatLatency(result.durationMs),
        y: headersY + TABLE_HEAD_HEIGHT + index * ROW_HEIGHT,
    }));
    const footerY = headersY + TABLE_HEAD_HEIGHT + rows.length * ROW_HEIGHT + 20;
    return {
        chart: {
            layout,
            mostEfficient: text.mostEfficient,
            points: layout.points.map((point) => ({ ...point, name: nameOf(point.entry) })),
            xMetric: chart.x,
            yMetric: chart.y,
            series: chart.series.map((series) => ({
                key: series.key,
                entry: series.entry,
                points: series.points
                    .map((point) => byEntry.get(point.entryIndex))
                    .filter((point) => point !== undefined)
                    .map((point) => `${point.cx},${point.cy}`),
            })),
            top: chartTop,
            xTitle: text.xTitle,
            yTitle: text.yTitle,
        },
        footer: { madeWith: text.madeWith, y: footerY + FOOTER_HEIGHT / 2 },
        headers: {
            cost: text.cost,
            quality: source === 'none' ? undefined : text.quality,
            time: text.time,
            y: headersY,
        },
        height: footerY + FOOTER_HEIGHT,
        rows,
        subtitle: text.subtitle,
        title: truncateForCard(input.title, TITLE_MAX_CHARACTERS),
        width: SHARE_CARD_WIDTH,
    };
}

function escapeXml(text: string): string {
    return text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function marker(shape: MarkerShape, cx: number, cy: number, size: number, color: string): string {
    if (shape === 'square') {
        const side = size * 1.7;
        return `<rect x="${cx - side / 2}" y="${cy - side / 2}" width="${side}" height="${side}" rx="1.5" fill="${color}"/>`;
    }
    if (shape === 'triangle') {
        return `<path d="M ${cx} ${cy - size * 1.2} L ${cx + size * 1.1} ${cy + size * 0.8} L ${cx - size * 1.1} ${cy + size * 0.8} Z" fill="${color}"/>`;
    }
    if (shape === 'diamond') {
        const reach = size * 1.15;
        return `<path d="M ${cx} ${cy - reach} L ${cx + reach} ${cy} L ${cx} ${cy + reach} L ${cx - reach} ${cy} Z" fill="${color}"/>`;
    }
    return `<circle cx="${cx}" cy="${cy}" r="${size}" fill="${color}"/>`;
}

/**
 * Serializes the card to a standalone SVG document with every color and font inlined. The chart mirrors the on-screen
 * one (axes, gridlines, model lines, frontier rings, labelled points) and the leaderboard reads below it.
 */
export function renderShareCardSvg(card: ShareCardModel, palette: ShareCardPalette): string {
    const { layout } = card.chart;
    const { plot } = layout;
    const right = card.width - PADDING;
    const qualityX = right - 190;
    const costX = right - 90;
    const parts: string[] = [
        `<svg xmlns="http://www.w3.org/2000/svg" width="${card.width}" height="${card.height}" viewBox="0 0 ${card.width} ${card.height}" font-family="${escapeXml(palette.fontFamily)}">`,
        `<rect width="${card.width}" height="${card.height}" fill="${palette.background}"/>`,
        `<text x="${PADDING}" y="${PADDING + 18}" font-size="22" font-weight="600" fill="${palette.foreground}">${escapeXml(card.title)}</text>`,
        `<text x="${PADDING}" y="${PADDING + 42}" font-size="12" fill="${palette.muted}">${escapeXml(card.subtitle)}</text>`,
        `<g transform="translate(${PADDING} ${card.chart.top})">`,
    ];
    for (const tick of layout.yTicks)
        parts.push(
            `<line x1="${plot.left}" x2="${plot.right}" y1="${tick.position}" y2="${tick.position}" stroke="${palette.border}" stroke-dasharray="2 3"/>`,
            `<text x="${plot.left - 8}" y="${tick.position + 3}" font-size="11" text-anchor="end" fill="${palette.muted}">${escapeXml(formatTick(card.chart.yMetric, tick.value))}</text>`,
        );
    for (const tick of layout.xTicks)
        parts.push(
            `<line x1="${tick.position}" x2="${tick.position}" y1="${plot.top}" y2="${plot.bottom}" stroke="${palette.border}" stroke-dasharray="2 3"/>`,
            `<text x="${tick.position}" y="${plot.bottom + 14}" font-size="11" text-anchor="middle" fill="${palette.muted}">${escapeXml(formatTick(card.chart.xMetric, tick.value))}</text>`,
        );
    parts.push(
        `<line x1="${plot.left}" x2="${plot.right}" y1="${plot.bottom}" y2="${plot.bottom}" stroke="${palette.border}"/>`,
        `<line x1="${plot.left}" x2="${plot.left}" y1="${plot.top}" y2="${plot.bottom}" stroke="${palette.border}"/>`,
        `<text x="${plot.right}" y="${plot.top - 10}" font-size="11" text-anchor="end" fill="${palette.muted}">${escapeXml(card.chart.mostEfficient)}</text>`,
        `<text x="${plot.left}" y="${plot.top - 10}" font-size="11" fill="${palette.muted}">${escapeXml(card.chart.yTitle)}</text>`,
        `<text x="${(plot.left + plot.right) / 2}" y="${plot.bottom + 34}" font-size="11" text-anchor="middle" fill="${palette.muted}">${escapeXml(card.chart.xTitle)}</text>`,
    );
    for (const series of card.chart.series)
        parts.push(
            `<polyline points="${series.points.join(' ')}" fill="none" stroke="${palette.series[series.entry.provider]}" stroke-width="1.5" opacity="0.7"/>`,
        );
    for (const point of card.chart.points) {
        const color = palette.series[point.entry.provider];
        if (point.isFrontier)
            parts.push(
                `<circle cx="${point.cx}" cy="${point.cy}" r="9" fill="none" stroke="${palette.foreground}" stroke-opacity="0.5"/>`,
            );
        parts.push(
            marker(markerShape(point.entry.provider), point.cx, point.cy, 5, color),
            `<text x="${point.labelX}" y="${point.labelY}" font-size="11" text-anchor="${point.labelAnchor === 'end' ? 'end' : 'start'}" fill="${palette.foreground}">${escapeXml(point.name)}${
                point.entry.effort
                    ? `<tspan dx="4" font-size="10" fill="${palette.muted}">${escapeXml(point.entry.effort.toUpperCase())}</tspan>`
                    : ''
            }</text>`,
        );
    }
    parts.push('</g>');
    const { headers } = card;
    parts.push(
        `<line x1="${PADDING}" x2="${right}" y1="${headers.y - 12}" y2="${headers.y - 12}" stroke="${palette.border}"/>`,
        `<text x="${PADDING}" y="${headers.y + 8}" font-size="11" fill="${palette.muted}">#</text>`,
        `<text x="${right}" y="${headers.y + 8}" font-size="11" text-anchor="end" fill="${palette.muted}">${escapeXml(headers.time)}</text>`,
        `<text x="${costX}" y="${headers.y + 8}" font-size="11" text-anchor="end" fill="${palette.muted}">${escapeXml(headers.cost)}</text>`,
    );
    if (headers.quality)
        parts.push(
            `<text x="${qualityX}" y="${headers.y + 8}" font-size="11" text-anchor="end" fill="${palette.muted}">${escapeXml(headers.quality)}</text>`,
        );
    for (const row of card.rows) {
        const baseline = row.y + 14;
        parts.push(
            `<text x="${PADDING}" y="${baseline}" font-size="12" fill="${palette.muted}">${row.rank}</text>`,
            marker(
                markerShape(row.entry.provider),
                PADDING + 38,
                baseline - 4,
                4,
                palette.series[row.entry.provider],
            ),
            `<text x="${PADDING + 52}" y="${baseline}" font-size="13" fill="${palette.foreground}">${escapeXml(row.name)}</text>`,
            `<text x="${right}" y="${baseline}" font-size="13" text-anchor="end" fill="${palette.foreground}">${escapeXml(row.time)}</text>`,
            `<text x="${costX}" y="${baseline}" font-size="13" text-anchor="end" fill="${palette.foreground}">${escapeXml(row.cost)}</text>`,
        );
        if (row.quality !== undefined)
            parts.push(
                `<text x="${qualityX}" y="${baseline}" font-size="13" font-weight="600" text-anchor="end" fill="${palette.foreground}">${escapeXml(row.quality)}</text>`,
            );
    }
    parts.push(
        `<text x="${right}" y="${card.footer.y}" font-size="12" text-anchor="end" fill="${palette.muted}">${escapeXml(card.footer.madeWith)}</text>`,
        '</svg>',
    );
    return parts.join('');
}

/**
 * The suggested file name for a saved card: `caxri-benchmark-<title slug>-<UTC date>.png`. The slug keeps letters and
 * digits of any script, so a Chinese prompt summary still names its file.
 */
export function shareCardFileName(run: Pick<BenchmarkRun, 'createdAt' | 'title'>): string {
    const slug = run.title
        .toLowerCase()
        .replaceAll(/[^\p{L}\p{N}]+/gu, '-')
        .replaceAll(/^-+|-+$/gu, '')
        .slice(0, 40)
        .replaceAll(/-+$/gu, '');
    const date = new Date(run.createdAt).toISOString().slice(0, 10);
    return `${['caxri-benchmark', slug, date].filter(Boolean).join('-')}.png`;
}
