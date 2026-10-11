import type { CSSProperties } from 'react';
import { useDeferredValue, useMemo, useRef } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
import { TriangleAlert } from 'lucide-react';

import { cn } from '../../lib/utilities';
import type { DelimitedTable } from './csv-table';
import { describeTableIssues, describeTableSize, parseDelimitedTable } from './csv-table';

const ROW_HEIGHT = 24;

/**
 * One grid template for the header and every row, so columns line up without measuring the DOM: the row-number gutter
 * sized to the largest row number, then each column at its estimated width plus the cell's horizontal padding. Every
 * row is its own grid, so no track may depend on that row's content.
 */
function gridTemplate(table: DelimitedTable): CSSProperties {
    const gutter = Math.max(3, String(table.rows.length).length);
    const columns = table.columnWidths.map((width) => `calc(${width}ch + 16px)`).join(' ');
    return { gridTemplateColumns: `calc(${gutter}ch + 16px) ${columns}` };
}

function TableRow({
    cells,
    numericColumns,
    rowIndex,
    style,
}: {
    cells: readonly string[];
    numericColumns: readonly boolean[];
    rowIndex: number;
    style: CSSProperties;
}) {
    return (
        <div
            aria-rowindex={rowIndex + 2}
            className="absolute top-0 left-0 grid min-w-full border-b border-border"
            role="row"
            style={style}
        >
            <span
                className="sticky left-0 truncate border-r border-border bg-background px-2 text-right leading-6 text-muted tabular-nums"
                role="rowheader"
            >
                {rowIndex + 1}
            </span>
            {cells.map((cell, column) => (
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
            ))}
        </div>
    );
}

/**
 * The table reading view for CSV and TSV.
 *
 * Parsing runs on the deferred source, so typing in the editor beside it never waits on a re-split. Only the rows in
 * view are mounted; the header and the row-number gutter stay pinned while the body scrolls both ways. Column widths
 * come from the content sample, and a cell wider than its column truncates: the source tab is where a long value is
 * read in full.
 */
export function CsvPreview({ path, source }: { path: string; source: string }) {
    const scrollReference = useRef<HTMLDivElement>(null);
    const deferredSource = useDeferredValue(source);
    const table = useMemo(() => parseDelimitedTable(deferredSource, path), [deferredSource, path]);
    const template = useMemo(() => gridTemplate(table), [table]);
    const issues = describeTableIssues(table);
    // TanStack Virtual is knowingly incompatible with React Compiler memoization; the compiler skips this component,
    // which is the library's documented, expected behavior.
    // eslint-disable-next-line react-hooks/incompatible-library -- see above
    const virtualizer = useVirtualizer({
        count: table.rows.length,
        estimateSize: () => ROW_HEIGHT,
        getScrollElement: () => scrollReference.current,
        overscan: 12,
        // The sticky header sits above the first row inside the same scroller.
        scrollMargin: ROW_HEIGHT,
    });

    return (
        <div className="flex h-full min-h-0 flex-col bg-background text-[12px] text-foreground">
            {issues && (
                <div
                    className="flex flex-none items-center gap-2 bg-surface px-3 py-1 text-warning"
                    role="status"
                >
                    <TriangleAlert aria-hidden="true" className="flex-none" size={13} />
                    <span className="min-w-0 truncate">{issues}</span>
                </div>
            )}
            {table.header.length === 0 ? (
                <div className="empty-work flex min-h-0 flex-1 items-center justify-center text-muted">
                    This file has no rows.
                </div>
            ) : (
                // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- rows are absolutely positioned by the virtualizer, which a native <table> layout cannot host.
                <div
                    ref={scrollReference}
                    aria-colcount={table.header.length + 1}
                    aria-label="Table preview"
                    aria-rowcount={table.rows.length + 1}
                    className="min-h-0 flex-1 overflow-auto"
                    role="table"
                >
                    <div className="w-max min-w-full">
                        <div
                            aria-rowindex={1}
                            className="sticky top-0 z-10 grid min-w-full border-b border-border bg-background font-semibold"
                            role="row"
                            style={template}
                        >
                            <span
                                className="sticky left-0 border-r border-border bg-background"
                                role="columnheader"
                            >
                                <span className="sr-only">Row</span>
                            </span>
                            {table.header.map((label, column) => (
                                <span
                                    key={column}
                                    className={cn(
                                        'truncate px-2 leading-6',
                                        table.numericColumns[column] && 'text-right',
                                    )}
                                    role="columnheader"
                                >
                                    {label}
                                </span>
                            ))}
                        </div>
                        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
                            {virtualizer.getVirtualItems().map((item) => (
                                <TableRow
                                    key={item.key}
                                    cells={table.rows[item.index]}
                                    numericColumns={table.numericColumns}
                                    rowIndex={item.index}
                                    style={{
                                        ...template,
                                        height: ROW_HEIGHT,
                                        transform: `translateY(${item.start - ROW_HEIGHT}px)`,
                                    }}
                                />
                            ))}
                        </div>
                    </div>
                </div>
            )}
            <div className="flex h-6 flex-none items-center justify-center bg-surface text-[11px] text-muted tabular-nums">
                {describeTableSize(table)}
            </div>
        </div>
    );
}
