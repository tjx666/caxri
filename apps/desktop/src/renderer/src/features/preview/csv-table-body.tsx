import type { CSSProperties, MouseEvent, PointerEvent } from 'react';

import type { VirtualItem } from '@tanstack/react-virtual';

import type { DelimitedTable } from './csv-table';
import { TABLE_HEADER_HEIGHT, TABLE_ROW_HEIGHT } from './csv-table';
import { CsvTableRow } from './csv-table-row';
import type { TableCellPosition, TableSelectionBounds } from './csv-table-selection';

/**
 * The table's body row group: only the rows the virtualizer has in view, each translated to its position under the
 * sticky header. One delegated listener selects for every row; cells carry their position as data.
 */
export function CsvTableBody({
    activeCell,
    activeCellId,
    clipWidths,
    items,
    onContextMenu,
    onPointerDown,
    rowOrder,
    selectionBounds,
    table,
    template,
    totalSize,
}: {
    /**
     * The cell the keyboard acts on, in view rows.
     */
    activeCell: TableCellPosition;
    activeCellId: string;
    clipWidths: readonly number[];
    items: readonly VirtualItem[];
    onContextMenu: (event: MouseEvent) => void;
    onPointerDown: (event: PointerEvent) => void;
    rowOrder: readonly number[];
    selectionBounds: TableSelectionBounds | undefined;
    table: DelimitedTable;
    template: CSSProperties;
    /**
     * The virtualizer's total row height, so the scroller's extent covers every row.
     */
    totalSize: number;
}) {
    return (
        <div
            className="relative select-none"
            role="rowgroup"
            style={{ height: totalSize }}
            onContextMenu={onContextMenu}
            onPointerDown={onPointerDown}
        >
            {items.map((item) => (
                <CsvTableRow
                    key={item.key}
                    activeCellId={activeCellId}
                    activeColumn={item.index === activeCell.row ? activeCell.column : undefined}
                    cells={table.rows[rowOrder[item.index]]}
                    columnWidths={clipWidths}
                    numericColumns={table.numericColumns}
                    position={item.index}
                    selectedColumns={
                        selectionBounds &&
                        item.index >= selectionBounds.top &&
                        item.index <= selectionBounds.bottom
                            ? selectionBounds
                            : undefined
                    }
                    sourceIndex={rowOrder[item.index]}
                    style={{
                        ...template,
                        height: TABLE_ROW_HEIGHT,
                        transform: `translateY(${item.start - TABLE_HEADER_HEIGHT}px)`,
                    }}
                />
            ))}
        </div>
    );
}
