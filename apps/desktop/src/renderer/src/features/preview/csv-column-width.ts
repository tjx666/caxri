import type { CSSProperties } from 'react';

import type { DelimitedTable } from './csv-table';
import { cellDisplayWidth, rowNumberGutterWidth } from './csv-table';

/**
 * Bounds for a column the reader resized, in CSS pixels: narrow enough to tuck a column away, never so narrow that its
 * resize handle can no longer be grabbed, and never wider than a few screens.
 */
export const MIN_RESIZED_COLUMN_WIDTH = 40;
export const MAX_RESIZED_COLUMN_WIDTH = 1200;

/**
 * The widest an auto-fit column grows, in `ch`. Auto-fit is asked for by the reader, so unlike the initial estimate it
 * is not held to a compact band, only kept from turning one long note into a column wider than the screen.
 */
const MAX_FIT_WIDTH = 120;

/**
 * Horizontal padding of a cell (`px-2` on both sides), plus the room the sorted column's direction arrow takes.
 */
const CELL_PADDING = 16;
const SORT_ICON_ROOM = 16;

/**
 * Column widths the reader set by dragging or double-clicking a column edge, by column index, in CSS pixels.
 */
export type ColumnWidthOverrides = Readonly<Partial<Record<number, number>>>;

export function clampColumnWidth(width: number): number {
    return Math.round(
        Math.min(MAX_RESIZED_COLUMN_WIDTH, Math.max(MIN_RESIZED_COLUMN_WIDTH, width)),
    );
}

/**
 * The width, in `ch`, that shows the column's widest value in full: every row, not the initial estimate's sample,
 * because the reader asked for this column specifically.
 */
export function fitColumnWidth(
    table: Pick<DelimitedTable, 'header' | 'rows'>,
    column: number,
): number {
    let widest = cellDisplayWidth(table.header[column] ?? '');
    for (const row of table.rows) {
        widest = Math.max(widest, cellDisplayWidth(row[column] ?? ''));
        if (widest >= MAX_FIT_WIDTH) return MAX_FIT_WIDTH;
    }
    return Math.max(1, widest);
}

/**
 * Pixel width of a column `width` `ch` wide, from the measured width of one `ch` in the table's font: what an estimated
 * column renders at, and where an auto-fit column lands.
 */
export function columnPixels(width: number, chWidth: number, isSorted: boolean): number {
    return clampColumnWidth(width * chWidth + CELL_PADDING + (isSorted ? SORT_ICON_ROOM : 0));
}

/**
 * Each column's text width in `ch`, for deciding which cells are clipped: the estimate, or a resized column's pixel
 * width converted back through the measured `ch`.
 */
export function effectiveColumnWidths(
    columnWidths: readonly number[],
    overrides: ColumnWidthOverrides,
    chWidth: number,
): number[] {
    return columnWidths.map((width, column) => {
        const override = overrides[column];
        return override === undefined ? width : Math.max(0, (override - CELL_PADDING) / chWidth);
    });
}

/**
 * One grid template for the header and every row, so columns line up without measuring the DOM: the row-number gutter
 * sized to the largest row number, then each column at the reader's width or the estimated width plus the cell's
 * horizontal padding. The sorted column also makes room for its direction arrow, so the arrow never truncates the
 * label. Every row is its own grid, so no track may depend on that row's content.
 */
export function tableGridTemplate(
    table: Pick<DelimitedTable, 'columnWidths' | 'rows'>,
    sortedColumn: number | undefined,
    overrides: ColumnWidthOverrides,
): CSSProperties {
    const columns = table.columnWidths
        .map((width, column) => {
            const override = overrides[column];
            if (override !== undefined) return `${override}px`;
            const padding = CELL_PADDING + (column === sortedColumn ? SORT_ICON_ROOM : 0);
            return `calc(${width}ch + ${padding}px)`;
        })
        .join(' ');
    return { gridTemplateColumns: `${rowNumberGutterWidth(table.rows.length)} ${columns}` };
}
