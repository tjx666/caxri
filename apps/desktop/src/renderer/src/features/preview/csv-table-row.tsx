import type { CSSProperties } from 'react';

import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/utilities';
import { isCellClipped } from './csv-table';

/**
 * One data row. `position` is where the row sits in the current view (for `aria-rowindex`); `sourceIndex` is its row in
 * the file, which the gutter keeps showing after a sort or filter so the reader can find it in the source.
 */
export function CsvTableRow({
    cells,
    columnWidths,
    numericColumns,
    position,
    sourceIndex,
    style,
}: {
    cells: readonly string[];
    columnWidths: readonly number[];
    numericColumns: readonly boolean[];
    position: number;
    sourceIndex: number;
    style: CSSProperties;
}) {
    return (
        <div
            aria-rowindex={position + 2}
            className="absolute top-0 left-0 grid min-w-full border-b border-border"
            role="row"
            style={style}
        >
            <span
                className="sticky left-0 border-r border-border bg-background px-2 text-right leading-6 whitespace-nowrap text-muted tabular-nums"
                role="rowheader"
            >
                {sourceIndex + 1}
            </span>
            {cells.map((cell, column) => {
                const content = (
                    <span
                        // Columns are positional and never reorder, so the index is the cell's identity.
                        key={column}
                        className={cn(
                            'truncate px-2 leading-6',
                            numericColumns[column] && 'text-right tabular-nums',
                        )}
                        role="cell"
                    >
                        {cell}
                    </span>
                );
                // Only a cell the column cuts off carries a tooltip: one per visible cell would mount a popup tree for
                // every cell the virtualizer renders, to repeat text that is already fully on screen.
                return isCellClipped(cell, columnWidths[column]) ? (
                    <Tooltip key={column} content={cell}>
                        {content}
                    </Tooltip>
                ) : (
                    content
                );
            })}
        </div>
    );
}
