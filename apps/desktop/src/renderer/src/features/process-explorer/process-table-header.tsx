import type { RefObject } from 'react';

import { ChevronDown, ChevronUp } from 'lucide-react';

import { ColumnResizeHandle } from '../../components/column-resize-handle';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { ProcessColumnDefinition, ProcessColumnKey, ProcessSort } from './process-columns';
import {
    PROCESS_COLUMN_MAX_WIDTH,
    PROCESS_COLUMN_RESIZE_STEP,
    PROCESS_COLUMNS,
    PROCESS_GRID_TEMPLATE,
    processColumnWidthVariable,
} from './process-columns';

function ProcessColumnResizer({
    column,
    gridReference,
    onCommit,
    onReset,
    width,
}: {
    column: ProcessColumnDefinition;
    /**
     * The scrolling grid that owns the width custom properties. The drag writes them directly so a pointer move never
     * re-renders the process rows.
     */
    gridReference: RefObject<HTMLDivElement | null>;
    onCommit: (width: number) => void;
    onReset: () => void;
    width: number;
}) {
    const { t } = useTranslation();
    return (
        <ColumnResizeHandle
            label={t('processExplorer.header.resize', { column: t(column.labelKey) })}
            max={PROCESS_COLUMN_MAX_WIDTH}
            min={column.minWidth}
            step={PROCESS_COLUMN_RESIZE_STEP}
            width={width}
            onCommit={onCommit}
            onDragMove={(next) =>
                gridReference.current?.style.setProperty(
                    processColumnWidthVariable(column.key),
                    `${next}px`,
                )
            }
            onReset={onReset}
        />
    );
}

export function ProcessTableHeader({
    gridReference,
    onResetWidth,
    onResize,
    onSort,
    sort,
    widths,
}: {
    gridReference: RefObject<HTMLDivElement | null>;
    onResetWidth: (key: ProcessColumnKey) => void;
    onResize: (key: ProcessColumnKey, width: number) => void;
    onSort: (key: ProcessColumnKey) => void;
    sort: ProcessSort;
    widths: Record<ProcessColumnKey, number>;
}) {
    const { t } = useTranslation();
    return (
        <div
            className="process-header sticky top-0 z-10 grid border-b border-border bg-surface"
            role="row"
            style={{ gridTemplateColumns: PROCESS_GRID_TEMPLATE }}
        >
            {PROCESS_COLUMNS.map((column) => {
                const isSorted = sort.column === column.key;
                const label = t(column.labelKey);
                const SortIcon = sort.direction === 'ascending' ? ChevronUp : ChevronDown;
                return (
                    <div
                        key={column.key}
                        role="columnheader"
                        /*
                         * Named explicitly because the cell's contents would otherwise compose the sort button's label
                         * with the resize handle's ("Sort by PID Resize PID column").
                         */
                        aria-label={label}
                        aria-sort={isSorted ? sort.direction : 'none'}
                        className={cn(
                            'relative flex min-h-7 items-stretch border-l border-border',
                            column.key === 'name' && 'border-l-0',
                        )}
                    >
                        <button
                            type="button"
                            className={cn(
                                'flex min-w-0 flex-1 cursor-pointer items-center gap-1 border-0 bg-transparent px-3 text-left text-[12px] font-semibold text-muted hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground',
                                // Numeric cells are right-aligned so digits line up; their headers follow.
                                column.isNumeric && 'flex-row-reverse text-right',
                                isSorted && 'text-foreground',
                            )}
                            aria-label={t('processExplorer.header.sortBy', { column: label })}
                            onClick={() => onSort(column.key)}
                        >
                            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                                {label}
                            </span>
                            <SortIcon
                                className={cn('shrink-0', !isSorted && 'invisible')}
                                size={12}
                            />
                        </button>
                        <ProcessColumnResizer
                            column={column}
                            gridReference={gridReference}
                            width={widths[column.key]}
                            onCommit={(next) => onResize(column.key, next)}
                            onReset={() => onResetWidth(column.key)}
                        />
                    </div>
                );
            })}
        </div>
    );
}
