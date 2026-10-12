/**
 * A cell in the table as shown: `row` is the row's position in the current (sorted, filtered) view, not its row in the
 * file, so a Shift-extended range covers exactly the rows the reader sees between the two clicks.
 */
export interface TableCellPosition {
    row: number;
    column: number;
}

/**
 * A rectangular cell range, from the cell the reader clicked first to the one the range extends to.
 */
export interface TableSelection {
    anchor: TableCellPosition;
    focus: TableCellPosition;
}

export interface TableSelectionBounds {
    top: number;
    bottom: number;
    left: number;
    right: number;
}

/**
 * The selection after a click: a plain click starts a new single-cell range, a Shift click extends the current range
 * from its anchor (or starts one when nothing is selected yet).
 */
export function nextTableSelection(
    current: TableSelection | undefined,
    position: TableCellPosition,
    isExtending: boolean,
): TableSelection {
    if (isExtending && current) return { anchor: current.anchor, focus: position };
    return { anchor: position, focus: position };
}

/**
 * The selection after a click on a row number: whole rows, from the first through the last column. Shift extends the
 * row range from the current anchor's row.
 */
export function nextTableRowSelection(
    current: TableSelection | undefined,
    row: number,
    columnCount: number,
    isExtending: boolean,
): TableSelection {
    const anchorRow = isExtending && current ? current.anchor.row : row;
    return {
        anchor: { row: anchorRow, column: 0 },
        focus: { row, column: Math.max(0, columnCount - 1) },
    };
}

export function tableSelectionBounds(selection: TableSelection): TableSelectionBounds {
    const { anchor, focus } = selection;
    return {
        top: Math.min(anchor.row, focus.row),
        bottom: Math.max(anchor.row, focus.row),
        left: Math.min(anchor.column, focus.column),
        right: Math.max(anchor.column, focus.column),
    };
}

export function isCellInBounds(
    bounds: TableSelectionBounds | undefined,
    row: number,
    column: number,
): boolean {
    if (!bounds) return false;
    return (
        row >= bounds.top && row <= bounds.bottom && column >= bounds.left && column <= bounds.right
    );
}

/**
 * One TSV field. A value holding a tab, a line break, or a quote is wrapped in quotes with inner quotes doubled, the
 * convention Excel, Numbers, and Google Sheets all read back, so a pasted multi-line cell stays one cell.
 */
export function tsvField(value: string): string {
    return /[\t\n\r"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Rows of cells as TSV: fields joined by tabs, records by line breaks, with no trailing line break so pasting one row
 * into an editor does not add an empty line after it.
 */
export function serializeTsv(rows: ReadonlyArray<readonly string[]>): string {
    return rows.map((row) => row.map((cell) => tsvField(cell)).join('\t')).join('\n');
}

/**
 * The text Cmd+C copies for a selection. A single cell copies its raw value, so pasting it anywhere gives exactly the
 * value with no TSV quoting; a range copies as TSV for a spreadsheet to split back into cells.
 *
 * @param rows The file's rows.
 * @param rowOrder The view's rows as source row indexes, which the selection's row positions index into.
 */
export function tableSelectionText(
    rows: ReadonlyArray<readonly string[]>,
    rowOrder: readonly number[],
    selection: TableSelection,
): string {
    const bounds = tableSelectionBounds(selection);
    const selected: string[][] = [];
    for (let position = bounds.top; position <= bounds.bottom; position += 1) {
        selected.push(rows[rowOrder[position]].slice(bounds.left, bounds.right + 1));
    }
    if (selected.length === 1 && selected[0].length === 1) return selected[0][0];
    return serializeTsv(selected);
}
