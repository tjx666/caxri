import { useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { ColumnWidthOverrides } from '../csv-column-width';
import {
    clampColumnWidth,
    columnLeftEdge,
    columnPixels,
    effectiveColumnWidths,
    fitColumnWidth,
    gutterPixels,
    tableGridTemplate,
} from '../csv-column-width';
import type { DelimitedTable } from '../csv-table';
import { TABLE_HEADER_HEIGHT, TABLE_ROW_HEIGHT } from '../csv-table';
import type { TableCellPosition } from '../csv-table-selection';
import { revealScrollOffset } from '../csv-table-selection';
import { readPreviewViewState, rememberPreviewViewState } from '../preview-view-state';

/**
 * Width of one `ch` before the table's font is measured, close to the UI font at 12px.
 */
const DEFAULT_CH_WIDTH = 7;

/**
 * The table's column geometry: the widths the reader resized or auto-fit (remembered per pane), the grid template and
 * clip widths derived from them, and the scroll that reveals a cell. One `ch` of the table font is measured through
 * `chProbeReference`, so a column fitted or resized in pixels matches its `ch` estimate.
 */
export function useCsvColumnWidths({
    sortColumn,
    table,
    viewStateKey,
}: {
    sortColumn: number | undefined;
    table: DelimitedTable;
    viewStateKey: string;
}) {
    const [columnWidths, setColumnWidths] = useState<ColumnWidthOverrides>(
        () => readPreviewViewState(viewStateKey)?.columnWidths ?? {},
    );
    const chProbeReference = useRef<HTMLSpanElement>(null);
    const [chWidth, setChWidth] = useState(DEFAULT_CH_WIDTH);
    const template = useMemo(
        () => tableGridTemplate(table, sortColumn, columnWidths),
        [columnWidths, sortColumn, table],
    );
    const clipWidths = useMemo(
        () => effectiveColumnWidths(table.columnWidths, columnWidths, chWidth),
        [chWidth, columnWidths, table.columnWidths],
    );
    const columnPixelWidths = table.columnWidths.map(
        (width, column) =>
            columnWidths[column] ?? columnPixels(width, chWidth, column === sortColumn),
    );
    const gutterWidth = gutterPixels(table.rows.length, chWidth);
    /**
     * Writes one column's width; `isFinal` also remembers it for this pane, which a drag does once on release rather
     * than on every pointer move.
     */
    const resizeColumn = (column: number, width: number, isFinal: boolean) => {
        const next = { ...columnWidths, [column]: clampColumnWidth(width) };
        setColumnWidths(next);
        if (isFinal) rememberPreviewViewState(viewStateKey, { columnWidths: next });
    };
    const autoFitColumn = (column: number) =>
        resizeColumn(
            column,
            columnPixels(fitColumnWidth(table, column), chWidth, column === sortColumn),
            true,
        );
    /**
     * Scrolls the table's scroller so a cell is fully visible, clear of the sticky header and row-number column.
     */
    const revealCell = (scroller: HTMLElement, cell: TableCellPosition) => {
        scroller.scrollTop = revealScrollOffset({
            scroll: scroller.scrollTop,
            viewport: scroller.clientHeight,
            start: TABLE_HEADER_HEIGHT + cell.row * TABLE_ROW_HEIGHT,
            size: TABLE_ROW_HEIGHT,
            inset: TABLE_HEADER_HEIGHT,
        });
        scroller.scrollLeft = revealScrollOffset({
            scroll: scroller.scrollLeft,
            viewport: scroller.clientWidth,
            start: columnLeftEdge(gutterWidth, columnPixelWidths, cell.column),
            size: columnPixelWidths[cell.column] ?? 0,
            inset: gutterWidth,
        });
    };
    useLayoutEffect(() => {
        const probe = chProbeReference.current;
        // The probe is 100ch wide, so one `ch` keeps its fractional part.
        if (probe && probe.offsetWidth > 0) setChWidth(probe.offsetWidth / 100);
    }, []);
    return {
        autoFitColumn,
        chProbeReference,
        clipWidths,
        columnPixelWidths,
        gutterWidth,
        resizeColumn,
        revealCell,
        template,
    };
}
