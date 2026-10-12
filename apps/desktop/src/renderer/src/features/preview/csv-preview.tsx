import type { PointerEvent as ReactPointerEvent } from 'react';
import { useDeferredValue, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useVirtualizer } from '@tanstack/react-virtual';
import { TriangleAlert } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useContextMenu } from '../../hooks/use-context-menu';
import type { Translate } from '../../i18n';
import { useTranslation } from '../../i18n';
import { tryCommand } from '../../stores/toasts';
import type { ColumnWidthOverrides } from './csv-column-width';
import {
    clampColumnWidth,
    columnLeftEdge,
    columnPixels,
    effectiveColumnWidths,
    fitColumnWidth,
    gutterPixels,
    tableGridTemplate,
} from './csv-column-width';
import type { TableSort } from './csv-row-view';
import { nextTableSort, tableRowSearchText, tableRowView } from './csv-row-view';
import {
    describeTableIssues,
    describeTableLimits,
    describeTableSize,
    isCellClipped,
    parseDelimitedTable,
} from './csv-table';
import { CsvTableFilter } from './csv-table-filter';
import { CsvTableHeader } from './csv-table-header';
import { CsvTableRow } from './csv-table-row';
import type { TableCellPosition, TableSelection } from './csv-table-selection';
import {
    clampTableSelection,
    isCellInBounds,
    nextTableKeyboardSelection,
    nextTableRowSelection,
    nextTableSelection,
    revealScrollOffset,
    serializeTsv,
    tableSelectionBounds,
    tableSelectionText,
} from './csv-table-selection';
import { openPreviewSource } from './preview-commands';
import { readPreviewViewState, rememberPreviewViewState } from './preview-view-state';

const ROW_HEIGHT = 24;
/**
 * The sticky header row: a body row's height plus its 1px bottom border. Body rows start below it, so scroll math that
 * assumed a 24px header left the last row 1px under the scroller's bottom edge.
 */
const HEADER_HEIGHT = ROW_HEIGHT + 1;

/**
 * Width of one `ch` before the table's font is measured, close to the UI font at 12px.
 */
const DEFAULT_CH_WIDTH = 7;

/**
 * The table cell an event happened in: its view row and its column, or `column: undefined` for the row-number gutter.
 */
function tableCellAt(target: EventTarget): (TableCellPosition & { isGutter: boolean }) | undefined {
    if (!(target instanceof Element)) return undefined;
    const cell = target.closest<HTMLElement>('[role="gridcell"], [role="rowheader"]');
    const row = cell?.closest<HTMLElement>('[data-position]');
    if (!cell || !row) return undefined;
    const isGutter = cell.getAttribute('role') === 'rowheader';
    return {
        row: Number(row.dataset.position),
        column: isGutter ? 0 : Number(cell.dataset.column),
        isGutter,
    };
}

async function copyTableText(text: string, t: Translate): Promise<void> {
    await tryCommand(t('preview.table.copyFailed'), () => navigator.clipboard.writeText(text));
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
 * The full text of the clipped active cell, below it, while the keyboard moves through the table: the keyboard's
 * counterpart of the hover tooltip a clipped cell shows the pointer, styled the same. The grid keeps focus (the cell is
 * only its active descendant), so the tooltip itself, which opens on its trigger's own focus, cannot serve here. Screen
 * readers already read the cell in full, since the truncation is visual only.
 */
function ActiveCellText({
    cell,
    isAbove,
    isClipped,
    left,
    top,
}: {
    cell: string | undefined;
    /**
     * Opens above the cell instead of below, for the last rows, where below would run past the end of the table.
     */
    isAbove: boolean;
    isClipped: boolean;
    left: number;
    /**
     * The cell's top edge in the table's scroll content.
     */
    top: number;
}) {
    if (!isClipped || cell === undefined) return null;
    return (
        <div
            aria-hidden="true"
            className="pointer-events-none absolute z-20 max-w-80 rounded-md bg-elevated px-2.5 py-1.5 text-[12px] wrap-anywhere whitespace-pre-line text-foreground shadow-[0_0_0_1px_var(--border),0_8px_24px_var(--shadow)]"
            style={
                isAbove
                    ? { left, top: top - 4, transform: 'translateY(-100%)' }
                    : { left, top: top + ROW_HEIGHT + 4 }
            }
        >
            {cell}
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
    const [columnWidths, setColumnWidths] = useState<ColumnWidthOverrides>(
        () => readPreviewViewState(viewStateKey)?.columnWidths ?? {},
    );
    const chProbeReference = useRef<HTMLSpanElement>(null);
    const [chWidth, setChWidth] = useState(DEFAULT_CH_WIDTH);
    const template = useMemo(
        () => tableGridTemplate(table, sort?.column, columnWidths),
        [columnWidths, sort?.column, table],
    );
    const clipWidths = useMemo(
        () => effectiveColumnWidths(table.columnWidths, columnWidths, chWidth),
        [chWidth, columnWidths, table.columnWidths],
    );
    const columnPixelWidths = table.columnWidths.map(
        (width, column) =>
            columnWidths[column] ?? columnPixels(width, chWidth, column === sort?.column),
    );
    /**
     * Writes one column's width; `isFinal` also remembers it for this pane, which a drag does once on release rather
     * than on every pointer move.
     */
    const resizeColumn = (column: number, width: number, isFinal: boolean) => {
        const next = { ...columnWidths, [column]: clampColumnWidth(width) };
        setColumnWidths(next);
        if (isFinal) rememberPreviewViewState(viewStateKey, { columnWidths: next });
    };
    /**
     * The selection is held with the sort and filter it was made under: positions index into the view's row order, so
     * once a new sort or filter reorders the rows the old selection no longer names the same cells and is dropped. A
     * source edit keeps it, moved inside the table if rows were removed. It is remembered for this pane, so the active
     * cell is where the reader left it after a tab switch.
     */
    const viewKey = `${deferredSort ? `${deferredSort.column}:${deferredSort.direction}` : ''}\0${deferredFilter}`;
    const tableBounds = { rows: rowOrder.length, columns: table.header.length };
    const [selectionState, setSelectionState] = useState(
        () => readPreviewViewState(viewStateKey)?.tableSelection,
    );
    const selection =
        selectionState?.viewKey === viewKey
            ? clampTableSelection(selectionState.selection, tableBounds)
            : undefined;
    const selectionBounds = selection ? tableSelectionBounds(selection) : undefined;
    const select = (next: TableSelection | undefined) => {
        const state = next && { viewKey, selection: next };
        setSelectionState(state);
        rememberPreviewViewState(viewStateKey, { tableSelection: state ?? null });
    };
    /**
     * The cell the keyboard acts on: the selection's focus, or the first cell before anything is selected.
     */
    const activeCell = selection?.focus ?? { row: 0, column: 0 };
    const activeCellId = `${useId()}-active-cell`;
    const [isTableFocused, setIsTableFocused] = useState(false);
    /**
     * Set by a navigation key and cleared by a pointer press, so the clipped-cell popup below follows the keyboard and
     * never lingers after a click, where the hover tooltip already serves the pointer.
     */
    const [isKeyboardActive, setIsKeyboardActive] = useState(false);
    const gutterWidth = gutterPixels(table.rows.length, chWidth);
    /**
     * Scrolls the table so a cell is fully visible, clear of the sticky header and row-number column.
     */
    const revealCell = (cell: TableCellPosition) => {
        const scroller = scrollReference.current;
        if (!scroller) return;
        scroller.scrollTop = revealScrollOffset({
            scroll: scroller.scrollTop,
            viewport: scroller.clientHeight,
            start: HEADER_HEIGHT + cell.row * ROW_HEIGHT,
            size: ROW_HEIGHT,
            inset: HEADER_HEIGHT,
        });
        scroller.scrollLeft = revealScrollOffset({
            scroll: scroller.scrollLeft,
            viewport: scroller.clientWidth,
            start: columnLeftEdge(gutterWidth, columnPixelWidths, cell.column),
            size: columnPixelWidths[cell.column] ?? 0,
            inset: gutterWidth,
        });
    };
    const selectAt = (position: ReturnType<typeof tableCellAt>, isExtending: boolean) => {
        if (!position) return;
        select(
            position.isGutter
                ? nextTableRowSelection(selection, position.row, table.header.length, isExtending)
                : nextTableSelection(selection, position, isExtending),
        );
    };
    const contextCell = useRef<TableCellPosition>(undefined);
    const openCellMenu = useContextMenu(() => {
        const cell = contextCell.current;
        const row = cell && table.rows[rowOrder[cell.row]];
        if (!cell || !row) return [];
        return [
            selection && {
                label: t('preview.table.copy'),
                shortcut: 'cmd+c',
                onSelect: () =>
                    copyTableText(tableSelectionText(table.rows, rowOrder, selection), t),
            },
            {
                label: t('preview.table.copyCell'),
                onSelect: () => copyTableText(row[cell.column] ?? '', t),
            },
            {
                label: t('preview.table.copyRow'),
                onSelect: () => copyTableText(serializeTsv([row]), t),
            },
        ];
    });
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
        scrollMargin: HEADER_HEIGHT,
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
        const probe = chProbeReference.current;
        // The probe is 100ch wide, so one `ch` keeps its fractional part.
        if (probe && probe.offsetWidth > 0) setChWidth(probe.offsetWidth / 100);
    }, []);

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
            className="relative flex h-full min-h-0 flex-col overflow-hidden bg-background text-[12px] text-foreground"
            onKeyDown={(event) => {
                if (!event.metaKey || event.key.toLowerCase() !== 'f') return;
                event.preventDefault();
                filterReference.current?.focus();
                filterReference.current?.select();
            }}
        >
            {/* Measures one `ch` of the table font, so a column fitted or resized in pixels matches its `ch` estimate. */}
            <span
                ref={chProbeReference}
                aria-hidden="true"
                className="pointer-events-none invisible absolute top-0 left-0 h-0 w-[100ch]"
            />
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
                        aria-activedescendant={
                            isTableFocused && rowOrder.length > 0 ? activeCellId : undefined
                        }
                        aria-multiselectable
                        aria-rowcount={rowOrder.length + 1}
                        className="group/table relative min-h-0 flex-1 overflow-auto outline-none"
                        role="grid"
                        // One tab stop: the grid keeps focus and names the active cell through `aria-activedescendant`,
                        // because the virtualizer unmounts rows (and any focused cell in them) as they scroll away.
                        tabIndex={0}
                        onBlur={(event) => {
                            if (event.target === event.currentTarget) setIsTableFocused(false);
                        }}
                        onFocus={(event) => {
                            if (event.target === event.currentTarget) setIsTableFocused(true);
                        }}
                        onKeyDown={(event) => {
                            if (event.target !== event.currentTarget) return;
                            const pageSize = Math.floor(
                                (event.currentTarget.clientHeight - HEADER_HEIGHT) / ROW_HEIGHT,
                            );
                            const moved = nextTableKeyboardSelection(
                                selection,
                                event,
                                tableBounds,
                                pageSize,
                            );
                            if (moved) {
                                event.preventDefault();
                                select(moved);
                                setIsKeyboardActive(true);
                                revealCell(moved.focus);
                                return;
                            }
                            if (!selection) return;
                            if (event.key === 'Escape') {
                                select(undefined);
                                return;
                            }
                            if (!event.metaKey || event.key.toLowerCase() !== 'c') return;
                            event.preventDefault();
                            // eslint-disable-next-line no-void -- intentional floating-promise discard; tryCommand reports a failure itself
                            void copyTableText(
                                tableSelectionText(table.rows, rowOrder, selection),
                                t,
                            );
                        }}
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
                                    columnPixelWidths={columnPixelWidths}
                                    header={table.header}
                                    numericColumns={table.numericColumns}
                                    sort={sort}
                                    style={template}
                                    onAutoFit={(column) =>
                                        resizeColumn(
                                            column,
                                            columnPixels(
                                                fitColumnWidth(table, column),
                                                chWidth,
                                                column === sort?.column,
                                            ),
                                            true,
                                        )
                                    }
                                    onResize={(column, width) => resizeColumn(column, width, false)}
                                    onResizeCommit={(column, width) =>
                                        resizeColumn(column, width, true)
                                    }
                                    onSort={(column) =>
                                        changeView({
                                            tableSort: nextTableSort(sort, column) ?? null,
                                        })
                                    }
                                />
                            </div>
                            {/* One delegated listener selects for every row; cells carry their position as data. */}
                            <div
                                className="relative select-none"
                                role="rowgroup"
                                style={{ height: virtualizer.getTotalSize() }}
                                onContextMenu={(event) => {
                                    const position = tableCellAt(event.target);
                                    if (!position) return;
                                    contextCell.current = position;
                                    // A right click outside the selection selects the cell under it first.
                                    if (
                                        !isCellInBounds(
                                            selectionBounds,
                                            position.row,
                                            position.column,
                                        )
                                    )
                                        selectAt(position, false);
                                    openCellMenu(event);
                                }}
                                onPointerDown={(event: ReactPointerEvent) => {
                                    setIsKeyboardActive(false);
                                    if (event.button !== 0) return;
                                    selectAt(tableCellAt(event.target), event.shiftKey);
                                }}
                            >
                                {virtualizer.getVirtualItems().map((item) => (
                                    <CsvTableRow
                                        key={item.key}
                                        activeCellId={activeCellId}
                                        activeColumn={
                                            item.index === activeCell.row
                                                ? activeCell.column
                                                : undefined
                                        }
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
                                            height: ROW_HEIGHT,
                                            transform: `translateY(${item.start - HEADER_HEIGHT}px)`,
                                        }}
                                    />
                                ))}
                            </div>
                            {isTableFocused && isKeyboardActive && (
                                <ActiveCellText
                                    cell={table.rows[rowOrder[activeCell.row]]?.[activeCell.column]}
                                    isClipped={isCellClipped(
                                        table.rows[rowOrder[activeCell.row]]?.[activeCell.column] ??
                                            '',
                                        clipWidths[activeCell.column],
                                    )}
                                    left={columnLeftEdge(
                                        gutterWidth,
                                        columnPixelWidths,
                                        activeCell.column,
                                    )}
                                    isAbove={
                                        activeCell.row >= 4 && activeCell.row >= rowOrder.length - 4
                                    }
                                    top={HEADER_HEIGHT + activeCell.row * ROW_HEIGHT}
                                />
                            )}
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
