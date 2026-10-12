import type { CSSProperties } from 'react';

import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { isCellClipped } from './csv-table';

/**
 * A selected cell: the inactive selection color, switching to the active one while the table has focus (Cmd+C copies
 * only then), the way a list row shows whether its selection is the one the keyboard acts on.
 */
/**
 * The active cell's focus ring, shown while the table has focus: the accent outline the Activity chart uses, inset so
 * the neighboring cells and the sticky gutter never clip it.
 */
const ACTIVE_CELL =
    'group-focus/table:data-[active=true]:outline group-focus/table:data-[active=true]:-outline-offset-1 group-focus/table:data-[active=true]:outline-accent';

const SELECTED_CELL =
    'data-[selected=true]:bg-list-inactive-selection-background data-[selected=true]:text-list-inactive-selection-foreground group-focus/table:data-[selected=true]:bg-list-active-selection-background group-focus/table:data-[selected=true]:text-list-active-selection-foreground';

/**
 * One data row. `position` is where the row sits in the current view (for `aria-rowindex`); `sourceIndex` is its row in
 * the file, which the gutter keeps showing after a sort or filter so the reader can find it in the source.
 *
 * Cells carry their column and the row its position as data attributes, so the table handles clicks for every row with
 * one delegated listener instead of a closure per cell.
 */
export function CsvTableRow({
    activeCellId,
    activeColumn,
    cells,
    columnWidths,
    numericColumns,
    position,
    selectedColumns,
    sourceIndex,
    style,
}: {
    /**
     * The DOM id the active cell carries, which the grid names in `aria-activedescendant`.
     */
    activeCellId: string;
    /**
     * The active cell's column when it is in this row.
     */
    activeColumn: number | undefined;
    cells: readonly string[];
    columnWidths: readonly number[];
    numericColumns: readonly boolean[];
    position: number;
    /**
     * The selected column range in this row, when the selection covers it.
     */
    selectedColumns: { left: number; right: number } | undefined;
    sourceIndex: number;
    style: CSSProperties;
}) {
    return (
        <div
            aria-rowindex={position + 2}
            className="absolute top-0 left-0 grid min-w-full border-b border-border"
            data-position={position}
            role="row"
            style={style}
        >
            <span
                className={cn(
                    'sticky left-0 cursor-default border-r border-border bg-background px-2 text-right leading-6 whitespace-nowrap text-muted tabular-nums',
                    SELECTED_CELL,
                )}
                data-selected={selectedColumns !== undefined}
                role="rowheader"
            >
                {sourceIndex + 1}
            </span>
            {cells.map((cell, column) => {
                const isActive = column === activeColumn;
                const isSelected =
                    selectedColumns !== undefined &&
                    column >= selectedColumns.left &&
                    column <= selectedColumns.right;
                const isClipped = isCellClipped(cell, columnWidths[column]);
                const content = (
                    <span
                        // Columns are positional and never reorder, so the index is the cell's identity.
                        key={column}
                        aria-selected={isSelected}
                        className={cn(
                            'cursor-default truncate px-2 leading-6',
                            numericColumns[column] && 'text-right tabular-nums',
                            SELECTED_CELL,
                            ACTIVE_CELL,
                        )}
                        data-active={isActive}
                        data-column={column}
                        data-selected={isSelected}
                        // A clipped cell also passes it as the tooltip's `triggerId`. Base UI merges this child's props last,
                        // so leaving `id={undefined}` here would erase the trigger's id; the two must agree.
                        id={isActive ? activeCellId : undefined}
                        role="gridcell"
                    >
                        {cell}
                    </span>
                );
                // Only a cell the column cuts off carries a tooltip: one per visible cell would mount a popup tree for
                // every cell the virtualizer renders, to repeat text that is already fully on screen.
                return isClipped ? (
                    <Tooltip
                        key={column}
                        content={cell}
                        triggerId={isActive ? activeCellId : undefined}
                    >
                        {content}
                    </Tooltip>
                ) : (
                    content
                );
            })}
        </div>
    );
}
