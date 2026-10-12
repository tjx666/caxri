import { useState } from 'react';

import type { TableSort } from '../csv-row-view';
import type { TableBounds, TableCellPosition, TableSelection } from '../csv-table-selection';
import {
    clampTableSelection,
    nextTableRowSelection,
    nextTableSelection,
    tableSelectionBounds,
} from '../csv-table-selection';
import { readPreviewViewState, rememberPreviewViewState } from '../preview-view-state';

/**
 * The table's cell selection.
 *
 * The selection is held with the sort and filter it was made under: positions index into the view's row order, so once
 * a new sort or filter reorders the rows the old selection no longer names the same cells and is dropped. A source edit
 * keeps it, moved inside the table if rows were removed. It is remembered for this pane, so the active cell is where
 * the reader left it after a tab switch.
 */
export function useCsvTableSelection({
    bounds,
    filter,
    sort,
    viewStateKey,
}: {
    bounds: TableBounds;
    /**
     * The filter the rows on screen were laid out with.
     */
    filter: string;
    /**
     * The sort the rows on screen were laid out with.
     */
    sort: TableSort | undefined;
    viewStateKey: string;
}) {
    const viewKey = `${sort ? `${sort.column}:${sort.direction}` : ''}\0${filter}`;
    const [selectionState, setSelectionState] = useState(
        () => readPreviewViewState(viewStateKey)?.tableSelection,
    );
    const selection =
        selectionState?.viewKey === viewKey
            ? clampTableSelection(selectionState.selection, bounds)
            : undefined;
    const selectionBounds = selection ? tableSelectionBounds(selection) : undefined;
    const select = (next: TableSelection | undefined) => {
        const state = next && { viewKey, selection: next };
        setSelectionState(state);
        rememberPreviewViewState(viewStateKey, { tableSelection: state ?? null });
    };
    /**
     * Selects from a pointer on a cell; a press on the row-number gutter selects the whole row.
     */
    const selectAt = (
        position: (TableCellPosition & { isGutter: boolean }) | undefined,
        isExtending: boolean,
    ) => {
        if (!position) return;
        select(
            position.isGutter
                ? nextTableRowSelection(selection, position.row, bounds.columns, isExtending)
                : nextTableSelection(selection, position, isExtending),
        );
    };
    return { select, selectAt, selection, selectionBounds };
}
