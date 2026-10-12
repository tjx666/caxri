import type { CSSProperties } from 'react';
import { useDeferredValue, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
import { TriangleAlert } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import type { TableSort } from './csv-row-view';
import { nextTableSort, tableRowSearchText, tableRowView } from './csv-row-view';
import type { DelimitedTable } from './csv-table';
import {
    describeTableIssues,
    describeTableLimits,
    describeTableSize,
    parseDelimitedTable,
    rowNumberGutterWidth,
} from './csv-table';
import { CsvTableFilter } from './csv-table-filter';
import { CsvTableHeader } from './csv-table-header';
import { CsvTableRow } from './csv-table-row';
import { openPreviewSource } from './preview-commands';
import { readPreviewViewState, rememberPreviewViewState } from './preview-view-state';

const ROW_HEIGHT = 24;

/**
 * One grid template for the header and every row, so columns line up without measuring the DOM: the row-number gutter
 * sized to the largest row number, then each column at its estimated width plus the cell's horizontal padding. The
 * sorted column also makes room for its direction arrow (12px plus a 4px gap), so the arrow never truncates the label.
 * Every row is its own grid, so no track may depend on that row's content.
 */
function gridTemplate(table: DelimitedTable, sortedColumn: number | undefined): CSSProperties {
    const columns = table.columnWidths
        .map((width, column) => `calc(${width}ch + ${column === sortedColumn ? 32 : 16}px)`)
        .join(' ');
    return { gridTemplateColumns: `${rowNumberGutterWidth(table.rows.length)} ${columns}` };
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
    const filterReference = useRef<HTMLInputElement>(null);
    const [sort, setSort] = useState<TableSort | undefined>(
        () => readPreviewViewState(viewStateKey)?.tableSort ?? undefined,
    );
    const template = useMemo(() => gridTemplate(table, sort?.column), [sort?.column, table]);
    const [filter, setFilter] = useState(
        () => readPreviewViewState(viewStateKey)?.tableFilter ?? '',
    );
    const searchText = useMemo(() => tableRowSearchText(table.rows), [table]);
    /**
     * Deferred like the parse: a sort or filter over 50,000 rows renders in the background while the header click or
     * the keystroke that asked for it paints immediately.
     */
    const deferredSort = useDeferredValue(sort);
    const deferredFilter = useDeferredValue(filter);
    const rowOrder = useMemo(
        () => tableRowView(table, searchText, deferredSort, deferredFilter),
        [deferredFilter, deferredSort, searchText, table],
    );
    const warnings = [describeTableIssues(table, t), describeTableLimits(table, t)].filter(
        (message): message is string => message !== undefined,
    );
    // TanStack Virtual is knowingly incompatible with React Compiler memoization; the compiler skips this component,
    // which is the library's documented, expected behavior.
    // eslint-disable-next-line react-hooks/incompatible-library -- see above
    const virtualizer = useVirtualizer({
        count: rowOrder.length,
        estimateSize: () => ROW_HEIGHT,
        getScrollElement: () => scrollReference.current,
        initialOffset: () => readPreviewViewState(viewStateKey)?.scrollTop ?? 0,
        overscan: 12,
        // The sticky header sits above the first row inside the same scroller.
        scrollMargin: ROW_HEIGHT,
    });
    /**
     * A new order or filter starts reading from the top, where its first rows are, and is remembered for this pane.
     */
    const changeView = (next: { tableSort?: TableSort | null; tableFilter?: string }) => {
        if (next.tableSort !== undefined) setSort(next.tableSort ?? undefined);
        if (next.tableFilter !== undefined) setFilter(next.tableFilter);
        rememberPreviewViewState(viewStateKey, { ...next, scrollTop: 0 });
        if (scrollReference.current) scrollReference.current.scrollTop = 0;
    };

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
        // The filter takes Cmd+F from anywhere in the table, the way a find field does in an editor.
        <div
            className="flex h-full min-h-0 flex-col bg-background text-[12px] text-foreground"
            onKeyDown={(event) => {
                if (!event.metaKey || event.key.toLowerCase() !== 'f') return;
                event.preventDefault();
                filterReference.current?.focus();
                filterReference.current?.select();
            }}
        >
            {warnings.length > 0 && <TableWarnings messages={warnings} path={path} t={t} />}
            {table.header.length === 0 ? (
                <div className="empty-work flex min-h-0 flex-1 items-center justify-center text-muted">
                    {t('preview.table.noRows')}
                </div>
            ) : (
                <>
                    <div className="flex h-8 flex-none items-center bg-surface px-2">
                        <CsvTableFilter
                            inputRef={filterReference}
                            value={filter}
                            onChange={(value) => changeView({ tableFilter: value })}
                        />
                    </div>
                    {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role -- rows are absolutely positioned by the virtualizer, which a native <table> layout cannot host. */}
                    <div
                        ref={scrollReference}
                        aria-colcount={table.header.length + 1}
                        aria-label={t('preview.table.label')}
                        aria-rowcount={rowOrder.length + 1}
                        className="relative min-h-0 flex-1 overflow-auto"
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
                                <CsvTableHeader
                                    header={table.header}
                                    numericColumns={table.numericColumns}
                                    sort={sort}
                                    style={template}
                                    onSort={(column) =>
                                        changeView({
                                            tableSort: nextTableSort(sort, column) ?? null,
                                        })
                                    }
                                />
                            </div>
                            <div
                                className="relative"
                                role="rowgroup"
                                style={{ height: virtualizer.getTotalSize() }}
                            >
                                {virtualizer.getVirtualItems().map((item) => (
                                    <CsvTableRow
                                        key={item.key}
                                        cells={table.rows[rowOrder[item.index]]}
                                        columnWidths={table.columnWidths}
                                        numericColumns={table.numericColumns}
                                        position={item.index}
                                        sourceIndex={rowOrder[item.index]}
                                        style={{
                                            ...template,
                                            height: ROW_HEIGHT,
                                            transform: `translateY(${item.start - ROW_HEIGHT}px)`,
                                        }}
                                    />
                                ))}
                            </div>
                        </div>
                        {rowOrder.length === 0 && table.rows.length > 0 && (
                            <div className="empty-work absolute inset-x-0 top-12 text-center text-muted">
                                {t('preview.table.noMatches')}
                            </div>
                        )}
                    </div>
                </>
            )}
            <div className="flex h-6 flex-none items-center justify-center bg-surface text-[11px] text-muted tabular-nums">
                {describeTableSize(table, t, rowOrder.length)}
            </div>
        </div>
    );
}
