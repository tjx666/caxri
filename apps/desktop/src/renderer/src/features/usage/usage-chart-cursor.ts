/**
 * Keyboard inspection of the Usage charts: one cursor model shared by the Activity day grid, week bars, cumulative
 * line, and the Time of day bars, so every chart answers the same keys.
 *
 * - `linear`: items in a row (week bars, cumulative points, hours). Left and Right step one item.
 * - `grid`: the GitHub-style day grid, stored column-major with `rows` cells per week column. Left and Right step one
 *   week column, Up and Down one weekday row, matching where the cell sits on screen.
 *
 * Home and End jump to the first and last item. The first arrow press enters item mode at the latest item (today, this
 * week, or the last hour), because that is the figure a user most often looks for. Escape returns to the summary.
 */
/**
 * The keyboard cursor's ring on the current item, the same accent the chart's own focus outline uses.
 */
export const CHART_CURSOR_CLASS = 'outline outline-1 outline-offset-1 outline-accent';

export type ChartCursorLayout =
    { kind: 'linear'; count: number } | { kind: 'grid'; count: number; rows: number };

/**
 * `handled: false` leaves the key to the browser (Tab, page scroll, a dialog's Escape); a handled key moves or clears
 * the cursor and should not also scroll the page.
 */
export type ChartCursorMove = { handled: false } | { handled: true; cursor: number | undefined };

const NOT_HANDLED: ChartCursorMove = { handled: false };

export function moveChartCursor(
    layout: ChartCursorLayout,
    cursor: number | undefined,
    key: string,
): ChartCursorMove {
    const last = layout.count - 1;
    if (last < 0) return NOT_HANDLED;
    if (key === 'Escape')
        return cursor === undefined ? NOT_HANDLED : { handled: true, cursor: undefined };
    if (key === 'Home') return { handled: true, cursor: 0 };
    if (key === 'End') return { handled: true, cursor: last };
    const step = cursorStep(layout, key);
    if (step === undefined) return NOT_HANDLED;
    if (cursor === undefined) return { handled: true, cursor: last };
    const current = Math.min(cursor, last);
    const next = current + step;
    if (next < 0 || next > last) return { handled: true, cursor: current };
    // Up and Down stay inside one week column instead of wrapping into the neighboring week.
    if (
        layout.kind === 'grid' &&
        Math.abs(step) === 1 &&
        Math.floor(next / layout.rows) !== Math.floor(current / layout.rows)
    )
        return { handled: true, cursor: current };
    return { handled: true, cursor: next };
}

function cursorStep(layout: ChartCursorLayout, key: string): number | undefined {
    const column = layout.kind === 'grid' ? layout.rows : 1;
    if (key === 'ArrowLeft') return -column;
    if (key === 'ArrowRight') return column;
    if (layout.kind === 'linear') return undefined;
    if (key === 'ArrowUp') return -1;
    if (key === 'ArrowDown') return 1;
    return undefined;
}
