import type { CSSProperties } from 'react';
import { useDeferredValue, useLayoutEffect, useMemo, useRef } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
import { TriangleAlert } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { cn } from '../../lib/utilities';
import type { DelimitedTable } from './csv-table';
import {
    describeTableIssues,
    describeTableLimits,
    describeTableSize,
    isCellClipped,
    parseDelimitedTable,
    rowNumberGutterWidth,
} from './csv-table';
import { openPreviewSource } from './preview-commands';
import { readPreviewViewState, rememberPreviewViewState } from './preview-view-state';

const ROW_HEIGHT = 24;

/**
 * One grid template for the header and every row, so columns line up without measuring the DOM: the row-number gutter
 * sized to the largest row number, then each column at its estimated width plus the cell's horizontal padding. Every
 * row is its own grid, so no track may depend on that row's content.
 */
function gridTemplate(table: DelimitedTable): CSSProperties {
    const columns = table.columnWidths.map((width) => `calc(${width}ch + 16px)`).join(' ');
    return { gridTemplateColumns: `${rowNumberGutterWidth(table.rows.length)} ${columns}` };
}

function TableRow({
    cells,
    columnWidths,
    numericColumns,
    rowIndex,
    style,
}: {
    cells: readonly string[];
    columnWidths: readonly number[];
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
                className="sticky left-0 border-r border-border bg-background px-2 text-right leading-6 whitespace-nowrap text-muted tabular-nums"
                role="rowheader"
            >
                {rowIndex + 1}
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

/**
 * The warning bar above the table: parse problems and the bounds that cut the table off, plus the way to the whole
 * file. Both say the table is not the full truth of the source, so the source tab is the recovery for both.
 */
function TableWarnings({
    messages,
    path,
    t,
}: {
    messages: readonly string[];
    path: string;
    t: Translate;
}) {
    return (
        <div
            className="flex min-h-7 flex-none items-center gap-2 bg-surface py-0.5 pr-1 pl-3 text-warning"
            role="status"
        >
            <TriangleAlert aria-hidden="true" className="flex-none" size={13} />
            {/* The bar truncates to one line; the tooltip carries the whole reason (`role="status"` already reads it in full). */}
            <Tooltip content={messages.join(' ')}>
                <span className="min-w-0 flex-1 truncate">{messages.join(' ')}</span>
            </Tooltip>
            <Button
                className="flex-none"
                size="sm"
                variant="ghost"
                onClick={() => openPreviewSource(path)}
            >
                {t('preview.openSource')}
            </Button>
        </div>
    );
}

/**
 * The table reading view for CSV and TSV.
 *
 * Parsing runs on the deferred source, so typing in the editor beside it never waits on a re-split. Only the rows in
 * view are mounted; the header and the row-number gutter stay pinned while the body scrolls both ways. Column widths
 * come from the content sample, and a cell wider than its column truncates with its full value on hover. The scroll
 * position is remembered per pane, so switching tabs and back returns to the same rows.
 */
export function CsvPreview({
    path,
    source,
    viewStateKey,
}: {
    path: string;
    source: string;
    viewStateKey: string;
}) {
    const { t } = useTranslation();
    const scrollReference = useRef<HTMLDivElement>(null);
    const deferredSource = useDeferredValue(source);
    const table = useMemo(
        () => parseDelimitedTable(deferredSource, path, t),
        [deferredSource, path, t],
    );
    const template = useMemo(() => gridTemplate(table), [table]);
    const warnings = [describeTableIssues(table, t), describeTableLimits(table, t)].filter(
        (message): message is string => message !== undefined,
    );
    // TanStack Virtual is knowingly incompatible with React Compiler memoization; the compiler skips this component,
    // which is the library's documented, expected behavior.
    // eslint-disable-next-line react-hooks/incompatible-library -- see above
    const virtualizer = useVirtualizer({
        count: table.rows.length,
        estimateSize: () => ROW_HEIGHT,
        getScrollElement: () => scrollReference.current,
        initialOffset: () => readPreviewViewState(viewStateKey)?.scrollTop ?? 0,
        overscan: 12,
        // The sticky header sits above the first row inside the same scroller.
        scrollMargin: ROW_HEIGHT,
    });

    /**
     * Restores the horizontal position too, before paint; the virtualizer's `initialOffset` owns the vertical one so
     * its first render already mounts the rows that position shows.
     */
    useLayoutEffect(() => {
        const element = scrollReference.current;
        const remembered = readPreviewViewState(viewStateKey);
        if (!element || !remembered) return;
        element.scrollTop = remembered.scrollTop ?? 0;
        element.scrollLeft = remembered.scrollLeft ?? 0;
    }, [viewStateKey]);

    return (
        <div className="flex h-full min-h-0 flex-col bg-background text-[12px] text-foreground">
            {warnings.length > 0 && <TableWarnings messages={warnings} path={path} t={t} />}
            {table.header.length === 0 ? (
                <div className="empty-work flex min-h-0 flex-1 items-center justify-center text-muted">
                    {t('preview.table.noRows')}
                </div>
            ) : (
                // react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- rows are absolutely positioned by the virtualizer, which a native <table> layout cannot host.
                <div
                    ref={scrollReference}
                    aria-colcount={table.header.length + 1}
                    aria-label={t('preview.table.label')}
                    aria-rowcount={table.rows.length + 1}
                    className="min-h-0 flex-1 overflow-auto"
                    role="table"
                    onScroll={(event) =>
                        rememberPreviewViewState(viewStateKey, {
                            scrollTop: event.currentTarget.scrollTop,
                            scrollLeft: event.currentTarget.scrollLeft,
                        })
                    }
                >
                    {/* Layout only: the header and body row groups below are the table's direct structure. */}
                    <div className="w-max min-w-full" role="none">
                        <div className="sticky top-0 z-10" role="rowgroup">
                            <div
                                aria-rowindex={1}
                                className="grid min-w-full border-b border-border bg-background font-semibold"
                                role="row"
                                style={template}
                            >
                                <span
                                    className="sticky left-0 border-r border-border bg-background"
                                    role="columnheader"
                                >
                                    <span className="sr-only">{t('preview.table.rowHeader')}</span>
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
                        </div>
                        <div
                            className="relative"
                            role="rowgroup"
                            style={{ height: virtualizer.getTotalSize() }}
                        >
                            {virtualizer.getVirtualItems().map((item) => (
                                <TableRow
                                    key={item.key}
                                    cells={table.rows[item.index]}
                                    columnWidths={table.columnWidths}
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
                {describeTableSize(table, t)}
            </div>
        </div>
    );
}
