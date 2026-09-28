import type { RefObject } from 'react';

import { ChevronDown, ChevronUp } from 'lucide-react';

import { usePointerDragResize } from '../../hooks/use-pointer-drag-resize';
import { cn } from '../../lib/utilities';
import type { ProcessColumnDefinition, ProcessColumnKey, ProcessSort } from './process-columns';
import {
    PROCESS_COLUMN_MAX_WIDTH,
    PROCESS_COLUMN_RESIZE_STEP,
    PROCESS_COLUMNS,
    PROCESS_GRID_TEMPLATE,
    processColumnWidthVariable,
} from './process-columns';

/**
 * Applied to `document.body` for the duration of a drag; see `styles/process-explorer.css`. Suppresses the text
 * selection a horizontal gesture across the header would otherwise paint, which no utility class on the handle itself
 * can reach.
 */
const DRAG_CLASS = 'process-resize-active';

/**
 * Same seam vocabulary as the workbench `PanelDivider`: invisible at rest, a 6px hit band straddling the column border,
 * and a foreground-tinted hairline on hover, focus, and drag. The `color-mix` percentages are that divider's recipe
 * reused verbatim, per the DESIGN.md "State tokens" gap.
 */
const resizerClassName =
    'absolute inset-y-0 -right-[3px] z-20 w-1.5 cursor-col-resize touch-none ' +
    "after:content-[''] after:absolute after:inset-y-0 after:left-1/2 after:w-px after:-translate-x-1/2 after:bg-transparent after:pointer-events-none " +
    'hover:after:w-[3px] hover:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
    'data-[dragging=true]:after:w-[3px] data-[dragging=true]:after:bg-[color-mix(in_srgb,var(--foreground)_40%,transparent)] ' +
    'focus-visible:outline-none focus-visible:after:w-[3px] ' +
    'focus-visible:after:bg-[color-mix(in_srgb,var(--foreground)_55%,transparent)]';

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
    const dragResize = usePointerDragResize({
        value: width,
        min: column.minWidth,
        max: PROCESS_COLUMN_MAX_WIDTH,
        resolveValue: (event, start) => start.startValue + (event.clientX - start.startX),
        onDragMove: (next, event) => {
            gridReference.current?.style.setProperty(
                processColumnWidthVariable(column.key),
                `${next}px`,
            );
            event.currentTarget.setAttribute('aria-valuenow', String(Math.round(next)));
        },
        onCommit: (next, event) => {
            if (event) {
                document.body.classList.remove(DRAG_CLASS);
                delete event.currentTarget.dataset.dragging;
            }
            onCommit(next);
        },
        resolveStep: (event) => {
            if (event.key === 'ArrowLeft') return -PROCESS_COLUMN_RESIZE_STEP;
            if (event.key === 'ArrowRight') return PROCESS_COLUMN_RESIZE_STEP;
            return;
        },
        onReset,
    });
    return (
        <div
            role="separator"
            tabIndex={0}
            className={resizerClassName}
            aria-orientation="vertical"
            aria-label={`Resize ${column.label} column`}
            aria-valuemin={column.minWidth}
            aria-valuemax={PROCESS_COLUMN_MAX_WIDTH}
            aria-valuenow={Math.round(width)}
            onPointerDown={(event) => {
                dragResize.onPointerDown(event);
                document.body.classList.add(DRAG_CLASS);
                event.currentTarget.dataset.dragging = 'true';
            }}
            onPointerMove={dragResize.onPointerMove}
            onPointerUp={dragResize.onPointerUp}
            onPointerCancel={dragResize.onPointerCancel}
            onLostPointerCapture={dragResize.onLostPointerCapture}
            onDoubleClick={onReset}
            onKeyDown={dragResize.onKeyDown}
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
    return (
        <div
            className="process-header sticky top-0 z-10 grid border-b border-border bg-surface"
            role="row"
            style={{ gridTemplateColumns: PROCESS_GRID_TEMPLATE }}
        >
            {PROCESS_COLUMNS.map((column) => {
                const isSorted = sort.column === column.key;
                const SortIcon = sort.direction === 'ascending' ? ChevronUp : ChevronDown;
                return (
                    <div
                        key={column.key}
                        role="columnheader"
                        /*
                         * Named explicitly because the cell's contents would otherwise compose the sort button's label
                         * with the resize handle's ("Sort by PID Resize PID column").
                         */
                        aria-label={column.label}
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
                            aria-label={`Sort by ${column.label}`}
                            onClick={() => onSort(column.key)}
                        >
                            <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                                {column.label}
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
