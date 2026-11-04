const DEFAULT_BAR_WIDTH = 4;
const BAR_GAP = 2;
const CHART_HEIGHT = 24;

/**
 * One bar of a {@link StatusBars} chart.
 */
export interface StatusBar {
    /**
     * Stable React key, such as the sample's timestamp or local day.
     */
    key: string;
    /**
     * Screen-reader text for this bar, such as `2026-11-04: $1.20`. The chart itself is decorative, so when any bar
     * carries a label they are all exposed as a visually hidden list.
     */
    label?: string;
    value: number;
}

/**
 * A hover card's small bar chart: values oldest to newest on a zero-based scale whose top is captioned, so the bars
 * read as values rather than as a shape. The newest bar is drawn in the foreground ink; the rest stay muted, and a zero
 * value keeps a one-pixel stub so its slot still reads as a day or sample. Renders nothing when every value is zero.
 */
export function StatusBars({
    barWidth = DEFAULT_BAR_WIDTH,
    bars,
    caption,
}: {
    /**
     * Pixel width of each bar; a short series such as a week of days reads better with wider bars.
     */
    barWidth?: number;
    bars: readonly StatusBar[];
    /**
     * Labels the top of the scale, such as `Max 112 tok/s`.
     */
    caption: (max: number) => string;
}) {
    const max = Math.max(...bars.map((bar) => bar.value));
    if (!(max > 0)) return null;
    const width = bars.length * (barWidth + BAR_GAP) - BAR_GAP;
    return (
        <span className="flex items-end gap-1.5">
            <svg
                aria-hidden="true"
                className="flex-none"
                height={CHART_HEIGHT}
                viewBox={`0 0 ${width} ${CHART_HEIGHT}`}
                width={width}
            >
                {bars.map((bar, index) => {
                    const height = Math.max(1, (bar.value / max) * CHART_HEIGHT);
                    return (
                        <rect
                            key={bar.key}
                            className={index === bars.length - 1 ? 'fill-foreground' : 'fill-muted'}
                            height={height}
                            rx={1}
                            width={barWidth}
                            x={index * (barWidth + BAR_GAP)}
                            y={CHART_HEIGHT - height}
                        />
                    );
                })}
            </svg>
            <span className="text-muted tabular-nums">{caption(max)}</span>
            {bars.some((bar) => bar.label) && (
                <ul className="sr-only">
                    {bars.map((bar) => (
                        <li key={bar.key}>{bar.label}</li>
                    ))}
                </ul>
            )}
        </span>
    );
}
