import type { CSSProperties } from 'react';

import { ArrowDown, ArrowUp } from 'lucide-react';

import { ColumnResizeHandle } from '../../components/column-resize-handle';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import { MAX_RESIZED_COLUMN_WIDTH, MIN_RESIZED_COLUMN_WIDTH } from './csv-column-width';
import type { TableSort } from './csv-row-view';

/**
 * Pixels an Arrow key moves a focused column edge.
 */
const RESIZE_STEP = 16;

/**
 * The pinned header row. Each column header is a button that cycles its sort (ascending, descending, file order) and
 * reports the current one through `aria-sort`, so the sort is reachable and announced from the keyboard. Its right edge
 * resizes the column: drag it, step it with Arrow keys, or double-click it to fit the column's widest value.
 */
export function CsvTableHeader({
    columnPixelWidths,
    header,
    numericColumns,
    sort,
    style,
    onAutoFit,
    onResize,
    onResizeCommit,
    onSort,
}: {
    /**
     * Each column's current width in CSS pixels, where a resize starts from.
     */
    columnPixelWidths: readonly number[];
    header: readonly string[];
    numericColumns: readonly boolean[];
    sort: TableSort | undefined;
    style: CSSProperties;
    onAutoFit: (column: number) => void;
    onResize: (column: number, width: number) => void;
    onResizeCommit: (column: number, width: number) => void;
    onSort: (column: number) => void;
}) {
    const { t } = useTranslation();
    return (
        // The row itself stays at the body's weight: its `ch` tracks resolve against its own font, and a bold row would
        // make every header column wider than the body column under it. Only the labels are bold.
        <div
            aria-rowindex={1}
            className="grid min-w-full border-b border-border bg-background"
            role="row"
            style={style}
        >
            <span
                className="sticky left-0 border-r border-border bg-background"
                role="columnheader"
            >
                <span className="sr-only">{t('preview.table.rowHeader')}</span>
            </span>
            {header.map((label, column) => {
                const direction = sort?.column === column ? sort.direction : undefined;
                const SortIcon = direction === 'descending' ? ArrowDown : ArrowUp;
                return (
                    <span
                        // Columns are positional and never reorder, so the index is the header's identity.
                        key={column}
                        // Named explicitly so the resize handle's label does not join the header's accessible name.
                        aria-label={label}
                        aria-sort={direction ?? 'none'}
                        className="relative min-w-0"
                        role="columnheader"
                    >
                        <button
                            className={cn(
                                'flex h-6 w-full min-w-0 cursor-pointer items-center gap-1 px-2 text-left font-semibold outline-none hover:bg-elevated focus-visible:bg-elevated',
                                numericColumns[column] && 'flex-row-reverse text-right',
                            )}
                            type="button"
                            onClick={() => onSort(column)}
                        >
                            <span className="min-w-0 truncate">{label}</span>
                            {direction && (
                                <SortIcon
                                    aria-hidden="true"
                                    className="flex-none text-muted"
                                    size={12}
                                />
                            )}
                        </button>
                        <ColumnResizeHandle
                            label={t('preview.table.resizeColumn', { column: label })}
                            max={MAX_RESIZED_COLUMN_WIDTH}
                            min={MIN_RESIZED_COLUMN_WIDTH}
                            step={RESIZE_STEP}
                            width={columnPixelWidths[column]}
                            onCommit={(width) => onResizeCommit(column, width)}
                            onDragMove={(width) => onResize(column, width)}
                            onReset={() => onAutoFit(column)}
                        />
                    </span>
                );
            })}
        </div>
    );
}
