import type { KeyboardEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ProcessExplorerSnapshot } from '@desktop-shared/process-explorer';
import { RefreshCw, Search } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Input, InputGroup } from '../../components/ui/input';
import { Tooltip, TooltipProvider } from '../../components/ui/tooltip';
import { useContainerWidth } from '../../hooks/use-container-width';
import { createVisibilityAwarePoll } from '../../lib/poll-scheduler';
import { formatCpuPercent, formatMemoryMb } from '../../lib/resource-usage-format';
import { applyCssTheme } from '../../lib/theme-css';
import { cn } from '../../lib/utilities';
import {
    PROCESS_GRID_MIN_WIDTH,
    processColumnWidthStyle,
    resolveProcessColumnWidths,
} from './process-columns';
import { ProcessRow } from './process-row';
import { ProcessTableHeader } from './process-table-header';
import type { ProcessRowVerticalKey, ProcessTreeRow } from './process-tree';
import {
    buildProcessTree,
    filterProcessTree,
    flattenProcessTree,
    nextProcessRowIndex,
    processExplorerTotals,
    processRowHorizontalIntent,
    rovingProcessRowId,
    setProcessNodeExpanded,
    setProcessSubtreeExpanded,
} from './process-tree';
import { useProcessTableState } from './use-process-table-state';

const SAMPLE_INTERVAL_MS = 2_000;

const processMessageClassName = 'process-message grid min-h-[120px] place-items-center text-muted';

const PROCESS_VERTICAL_KEYS: readonly ProcessRowVerticalKey[] = [
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
];

function isProcessVerticalKey(key: string): key is ProcessRowVerticalKey {
    return (PROCESS_VERTICAL_KEYS as readonly string[]).includes(key);
}

export function ProcessExplorerApp() {
    const [snapshot, setSnapshot] = useState<ProcessExplorerSnapshot>();
    /**
     * Rows the user flipped away from their default disclosure; see `isProcessNodeExpanded`.
     */
    const [toggled, setToggled] = useState<Set<string>>(() => new Set());
    const [filter, setFilter] = useState('');
    const [error, setError] = useState<string>();
    const [refreshing, setRefreshing] = useState(false);
    const refreshInFlight = useRef(false);
    /**
     * The last row the user focused, which owns the grid's roving Tab stop until that process leaves the sample.
     */
    const [focusedId, setFocusedId] = useState<string>();
    const rowsReference = useRef<HTMLDivElement>(null);
    const table = useProcessTableState();
    /**
     * Measured at 1px granularity because the untouched `Process Name` column is derived from it; an 8px bucket would
     * leave a visible gap between the last column and the window edge.
     */
    const [gridReference, gridWidth] = useContainerWidth<HTMLDivElement>(1);
    const refresh = useCallback((): void => {
        if (refreshInFlight.current) return;
        refreshInFlight.current = true;
        setRefreshing(true);
        async function runRefresh(): Promise<void> {
            try {
                const nextSnapshot = await globalThis.processExplorer.snapshot();
                setSnapshot(nextSnapshot);
                setError(undefined);
            } catch (error_: unknown) {
                // The visible copy is deliberately plain, so this is the only place the cause survives. Main mirrors
                // Renderer error-level console records into `desktop.jsonl` as an error class plus a stable digest
                // (`console-error-fields.ts`), which is what separates a one-off sampling failure from a repeating one.
                console.error('processExplorer.snapshot failed', error_);
                setSnapshot(undefined);
                setError('Unable to sample processes. Try again.');
            } finally {
                refreshInFlight.current = false;
                setRefreshing(false);
            }
        }
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void runRefresh();
    }, []);
    useEffect(() => {
        const initialRefresh = setTimeout(refresh, 0);
        // Registered in the shared poll registry (`lib/poll-scheduler.ts`) alongside the react-query polls so
        // `getActivePolls()` covers every periodic Renderer poll, not just the ones behind `useCaxriQuery`. Pauses
        // sampling while this standalone window is hidden/backgrounded and resumes with an immediate refresh, the
        // same contract `usePolledQuery` gives the Main-window polls.
        const poll = createVisibilityAwarePoll(
            'processExplorer.snapshot',
            SAMPLE_INTERVAL_MS,
            refresh,
        );
        async function loadTheme(): Promise<void> {
            try {
                applyCssTheme(await globalThis.processExplorer.theme());
            } catch {
                // Theme sync is best-effort; the process tree still renders with the default theme.
            }
        }
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void loadTheme();
        return () => {
            clearTimeout(initialRefresh);
            poll.dispose();
        };
    }, [refresh]);
    const roots = useMemo(
        () => (snapshot ? buildProcessTree(snapshot, table.sort) : []),
        [snapshot, table.sort],
    );
    const visibleRoots = useMemo(() => filterProcessTree(roots, filter), [filter, roots]);
    const totals = useMemo(
        () => processExplorerTotals(snapshot?.processes ?? []),
        [snapshot?.processes],
    );
    const widths = useMemo(
        () => resolveProcessColumnWidths(table.widths, gridWidth),
        [gridWidth, table.widths],
    );
    /**
     * The rows on screen, flattened once so the grid's single roving Tab stop and its arrow keys walk exactly what is
     * rendered. A filter opens every row so no match hides inside a folded Terminal.
     */
    const rows = useMemo(
        () => flattenProcessTree(visibleRoots, toggled, filter.trim().length > 0),
        [filter, toggled, visibleRoots],
    );
    const rovingId = rovingProcessRowId(rows, focusedId);
    const focusRow = (id: string): void =>
        rowsReference.current
            ?.querySelector<HTMLElement>(`[data-process-row-id="${CSS.escape(id)}"]`)
            ?.focus();
    const setRowExpanded = (row: ProcessTreeRow, isExpanded: boolean, isRecursive = false): void =>
        setToggled((current) =>
            isRecursive
                ? setProcessSubtreeExpanded(current, row.node, isExpanded)
                : setProcessNodeExpanded(current, row.node, isExpanded),
        );
    const toggle = (row: ProcessTreeRow, isRecursive: boolean): void =>
        setRowExpanded(row, !row.isExpanded, isRecursive);
    const stopTerminal = (terminalId: string, name: string): void => {
        async function runStop(): Promise<void> {
            try {
                await globalThis.processExplorer.stopTerminal(terminalId);
            } catch (error_: unknown) {
                console.error('processExplorer.stopTerminal failed', error_);
                setError(`Unable to stop ${name}. Try again.`);
                return;
            }
            refresh();
        }
        // eslint-disable-next-line no-void -- intentional floating-promise discard, runStop reports its own failure
        void runStop();
    };
    /**
     * The process list is a single Tab stop, so these keys are the only way to reach a row that is not the current one:
     * Up/Down/Home/End walk the visible rows, Left/Right collapse, expand, climb to the parent row, or step into the
     * first child, Enter/Space flip the focused row the way clicking it does, and Delete stops a focused Terminal.
     */
    const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: ProcessTreeRow): void => {
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        const index = rows.indexOf(row);
        if (index === -1) return;
        if (isProcessVerticalKey(event.key)) {
            const nextIndex = nextProcessRowIndex(rows, index, event.key);
            if (nextIndex === undefined) return;
            event.preventDefault();
            focusRow(rows[nextIndex].node.id);
            return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            const intent = processRowHorizontalIntent(rows, index, event.key);
            if (intent.expanded !== undefined) {
                event.preventDefault();
                setRowExpanded(row, intent.expanded);
            }
            if (intent.focusIndex !== undefined) {
                event.preventDefault();
                focusRow(rows[intent.focusIndex].node.id);
            }
            return;
        }
        if ((event.key === 'Enter' || event.key === ' ') && row.isExpandable) {
            event.preventDefault();
            toggle(row, false);
            return;
        }
        if ((event.key === 'Delete' || event.key === 'Backspace') && row.node.terminalId) {
            event.preventDefault();
            stopTerminal(row.node.terminalId, row.node.name);
        }
    };
    return (
        <TooltipProvider>
            <main
                className="process-explorer grid h-full w-full grid-rows-[42px_auto_minmax(0,1fr)_28px] bg-background"
                data-sampled-at={snapshot?.sampledAt}
            >
                <header className="process-titlebar relative flex items-center justify-center bg-title-bar-active-background px-12 pl-[84px] text-title-bar-active-foreground [-webkit-app-region:drag] window-inactive:bg-title-bar-inactive-background window-inactive:text-title-bar-inactive-foreground">
                    <strong className="overflow-hidden text-[12px] text-ellipsis whitespace-nowrap">
                        Process Explorer — Caxri
                    </strong>
                    <Tooltip content="Refresh processes">
                        <button
                            type="button"
                            className="absolute right-3 grid size-[26px] cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted [-webkit-app-region:no-drag] not-aria-disabled:hover:bg-elevated not-aria-disabled:hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground aria-disabled:cursor-default aria-disabled:opacity-55"
                            aria-label="Refresh processes"
                            aria-disabled={refreshing}
                            aria-busy={refreshing}
                            onClick={refresh}
                        >
                            <RefreshCw
                                className={cn(
                                    refreshing && 'animate-[process-spin_900ms_linear_infinite]',
                                )}
                                size={15}
                            />
                        </button>
                    </Tooltip>
                </header>
                <section
                    className="process-summary flex items-center gap-5 border-b border-border px-4 py-2.5 text-[12px] text-muted"
                    aria-label="Resource summary"
                >
                    <span>
                        CPU{' '}
                        <strong className="font-semibold text-foreground tabular-nums">
                            {snapshot ? formatCpuPercent(totals.cpuPercent) : '—'}
                        </strong>
                    </span>
                    <span>
                        Memory{' '}
                        <strong className="font-semibold text-foreground tabular-nums">
                            {snapshot ? formatMemoryMb(totals.memoryMb) : '—'}
                        </strong>
                        {snapshot && snapshot.systemMemoryMb > 0 && (
                            <span className="tabular-nums">
                                {' '}
                                / {formatMemoryMb(snapshot.systemMemoryMb)}
                            </span>
                        )}
                    </span>
                    <span>
                        Processes{' '}
                        <strong className="font-semibold text-foreground tabular-nums">
                            {snapshot ? totals.processCount : '—'}
                        </strong>
                    </span>
                    <InputGroup appearance="workbench" size="dense" className="ml-auto w-60">
                        <Search aria-hidden="true" className="shrink-0 text-muted" size={13} />
                        <Input
                            appearance="embedded"
                            size="dense"
                            type="search"
                            placeholder="Filter"
                            aria-label="Filter processes"
                            value={filter}
                            onChange={(event) => setFilter(event.target.value)}
                            onKeyDown={(event) => {
                                if (!filter || event.key !== 'Escape') return;
                                event.preventDefault();
                                setFilter('');
                            }}
                        />
                    </InputGroup>
                </section>
                <div
                    ref={gridReference}
                    className="process-grid min-h-0 overflow-auto"
                    role="treegrid"
                    aria-label="Caxri processes"
                    aria-busy={refreshing}
                    style={processColumnWidthStyle(widths)}
                >
                    <div role="rowgroup" style={{ minWidth: PROCESS_GRID_MIN_WIDTH }}>
                        <ProcessTableHeader
                            gridReference={gridReference}
                            sort={table.sort}
                            widths={widths}
                            onResetWidth={table.resetColumnWidth}
                            onResize={table.setColumnWidth}
                            onSort={table.toggleSort}
                        />
                        <div
                            ref={rowsReference}
                            className="process-rows"
                            role="presentation"
                            onFocusCapture={(event) => {
                                const id =
                                    event.target instanceof HTMLElement
                                        ? event.target.closest<HTMLElement>('[data-process-row-id]')
                                              ?.dataset.processRowId
                                        : undefined;
                                if (id) setFocusedId(id);
                            }}
                        >
                            {!snapshot && !error && (
                                <div className={processMessageClassName}>Loading processes…</div>
                            )}
                            {error && (
                                <div
                                    className={cn(
                                        processMessageClassName,
                                        'process-error text-danger',
                                    )}
                                >
                                    <p role="alert">{error}</p>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        aria-disabled={refreshing}
                                        onClick={refresh}
                                    >
                                        Retry
                                    </Button>
                                </div>
                            )}
                            {snapshot && roots.length === 0 && (
                                <div className={processMessageClassName}>
                                    No Caxri processes found.
                                </div>
                            )}
                            {snapshot && roots.length > 0 && rows.length === 0 && (
                                <div className={processMessageClassName}>
                                    No processes match “{filter.trim()}”.
                                </div>
                            )}
                            {rows.map((row) => (
                                <ProcessRow
                                    key={row.node.id}
                                    isRoving={row.node.id === rovingId}
                                    row={row}
                                    onKeyDown={handleRowKeyDown}
                                    onStopTerminal={stopTerminal}
                                    onToggle={toggle}
                                />
                            ))}
                        </div>
                    </div>
                </div>
                {/*
                 * Not a live region. Its timestamp changes on every two-second sample, so announcing it would talk
                 * over the user for as long as the window is open while saying nothing they asked for. The table
                 * already reports sampling through `aria-busy`, and this line stays readable on demand.
                 */}
                <footer className="flex items-center gap-1.5 border-t border-border px-3 text-[11px] text-muted">
                    <span
                        aria-hidden="true"
                        className={cn(
                            'size-1.5 rounded-full',
                            snapshot && !error ? 'bg-success' : 'bg-muted',
                        )}
                    />
                    Live · updates every {SAMPLE_INTERVAL_MS / 1_000} seconds
                    <span className="ml-auto tabular-nums">
                        {snapshot
                            ? `Updated ${new Date(snapshot.sampledAt).toLocaleTimeString('en-US')}`
                            : 'No current sample'}
                    </span>
                </footer>
            </main>
        </TooltipProvider>
    );
}
