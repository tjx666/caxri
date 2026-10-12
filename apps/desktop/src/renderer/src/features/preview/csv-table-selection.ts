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

/**
 * The table's extent in view rows and columns.
 */
export interface TableBounds {
    rows: number;
    columns: number;
}

/**
 * The part of a keydown that table navigation reads.
 */
export interface TableNavigationKey {
    key: string;
    /**
     * Cmd on macOS: with an arrow it jumps to that edge of the table, the way it jumps to a document edge in a text
     * field.
     */
    metaKey: boolean;
    /**
     * With Home or End it jumps to the first or last cell, the spreadsheet convention outside macOS.
     */
    ctrlKey: boolean;
}

/**
 * Where a navigation key moves the active cell: arrows move one cell, Cmd+arrow to that edge of the table, Home and End
 * to the start and end of the row (with Cmd or Ctrl, to the first and last cell), Page Up and Page Down by `pageSize`
 * rows. The result stays inside the table. Returns `undefined` for a key that is not a navigation key or an empty
 * table.
 */
export function moveActiveCell(
    position: TableCellPosition,
    input: TableNavigationKey,
    bounds: TableBounds,
    pageSize: number,
): TableCellPosition | undefined {
    if (bounds.rows <= 0 || bounds.columns <= 0) return undefined;
    const lastRow = bounds.rows - 1;
    const lastColumn = bounds.columns - 1;
    const isJump = input.metaKey;
    const isCornerJump = input.metaKey || input.ctrlKey;
    const page = Math.max(1, Math.floor(pageSize));
    let { row, column } = position;
    switch (input.key) {
        case 'ArrowUp': {
            row = isJump ? 0 : row - 1;
            break;
        }
        case 'ArrowDown': {
            row = isJump ? lastRow : row + 1;
            break;
        }
        case 'ArrowLeft': {
            column = isJump ? 0 : column - 1;
            break;
        }
        case 'ArrowRight': {
            column = isJump ? lastColumn : column + 1;
            break;
        }
        case 'Home': {
            column = 0;
            if (isCornerJump) row = 0;
            break;
        }
        case 'End': {
            column = lastColumn;
            if (isCornerJump) row = lastRow;
            break;
        }
        case 'PageUp': {
            row -= page;
            break;
        }
        case 'PageDown': {
            row += page;
            break;
        }
        default: {
            return undefined;
        }
    }
    return {
        row: Math.min(lastRow, Math.max(0, row)),
        column: Math.min(lastColumn, Math.max(0, column)),
    };
}

/**
 * The selection after a navigation key. The active cell is the selection's focus, or the first cell before anything is
 * selected. A plain key moves a single-cell selection; Shift keeps the anchor and extends the range to the moved cell.
 * Returns `undefined` when the key does not navigate.
 */
export function nextTableKeyboardSelection(
    current: TableSelection | undefined,
    input: TableNavigationKey & { shiftKey: boolean },
    bounds: TableBounds,
    pageSize: number,
): TableSelection | undefined {
    const active = current?.focus ?? { row: 0, column: 0 };
    const moved = moveActiveCell(active, input, bounds, pageSize);
    if (!moved) return undefined;
    if (input.shiftKey) return { anchor: current?.anchor ?? active, focus: moved };
    return { anchor: moved, focus: moved };
}

/**
 * A remembered selection moved inside the table, which may have fewer rows than when it was remembered (the source was
 * edited meanwhile). `undefined` once the table is empty.
 */
export function clampTableSelection(
    selection: TableSelection,
    bounds: TableBounds,
): TableSelection | undefined {
    if (bounds.rows <= 0 || bounds.columns <= 0) return undefined;
    const clamp = ({ row, column }: TableCellPosition): TableCellPosition => ({
        row: Math.min(bounds.rows - 1, Math.max(0, row)),
        column: Math.min(bounds.columns - 1, Math.max(0, column)),
    });
    return { anchor: clamp(selection.anchor), focus: clamp(selection.focus) };
}

/**
 * The scroll offset along one axis that brings `[start, start + size)` fully into view, moving as little as possible.
 * `inset` is the part of the viewport a pinned edge covers (the sticky header above, the row-number column on the
 * left), so a cell is never left under it.
 */
export function revealScrollOffset({
    scroll,
    viewport,
    start,
    size,
    inset,
}: {
    scroll: number;
    viewport: number;
    start: number;
    size: number;
    inset: number;
}): number {
    if (start - inset < scroll) return Math.max(0, start - inset);
    if (start + size > scroll + viewport) return start + size - viewport;
    return scroll;
}
