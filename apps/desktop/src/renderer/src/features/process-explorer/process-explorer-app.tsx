import type { KeyboardEvent } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { errorMessage } from '@caxri/protocol';
import type { ProcessExplorerSnapshot } from '@desktop-shared/process-explorer';
import { RefreshCw } from 'lucide-react';

import { TooltipProvider } from '../../components/ui/tooltip';
import { useContainerWidth } from '../../hooks/use-container-width';
import { createVisibilityAwarePoll } from '../../lib/poll-scheduler';
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
    flattenProcessTree,
    nextProcessRowIndex,
    processRowHorizontalIntent,
    rovingProcessRowPid,
    setProcessSubtreeCollapsed,
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
    const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
    const [error, setError] = useState<string>();
    const [refreshing, setRefreshing] = useState(false);
    /**
     * The last row the user focused, which owns the grid's roving Tab stop until that process leaves the sample.
     */
    const [focusedPid, setFocusedPid] = useState<number>();
    const rowsReference = useRef<HTMLDivElement>(null);
    const table = useProcessTableState();
    /**
     * Measured at 1px granularity because the untouched `Process Name` column is derived from it; an 8px bucket would
     * leave a visible gap between the last column and the window edge.
     */
    const [gridReference, gridWidth] = useContainerWidth<HTMLDivElement>(1);
    const refresh = useCallback((): void => {
        setRefreshing(true);
        async function runRefresh(): Promise<void> {
            try {
                const nextSnapshot = await globalThis.processExplorer.snapshot();
                setSnapshot(nextSnapshot);
                setError(undefined);
            } catch (error_: unknown) {
                setError(errorMessage(error_, 'Unable to sample processes'));
            } finally {
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
        () => buildProcessTree(snapshot?.processes ?? [], table.sort),
        [snapshot?.processes, table.sort],
    );
    const widths = useMemo(
        () => resolveProcessColumnWidths(table.widths, gridWidth),
        [gridWidth, table.widths],
    );
    /**
     * The rows on screen, flattened once so the grid's single roving Tab stop and its arrow keys walk exactly what is
     * rendered.
     */
    const rows = useMemo(() => flattenProcessTree(roots, collapsed), [collapsed, roots]);
    const rovingPid = rovingProcessRowPid(rows, focusedPid);
    const focusRow = (pid: number): void =>
        rowsReference.current
            ?.querySelector<HTMLElement>(`[data-process-pid="${CSS.escape(String(pid))}"]`)
            ?.focus();
    const setRowCollapsed = (
        row: ProcessTreeRow,
        isCollapsed: boolean,
        isRecursive = false,
    ): void =>
        setCollapsed((current) => {
            if (isRecursive) return setProcessSubtreeCollapsed(current, row.node, isCollapsed);
            const next = new Set(current);
            if (isCollapsed) next.add(row.node.pid);
            else next.delete(row.node.pid);
            return next;
        });
    const toggle = (row: ProcessTreeRow, isRecursive: boolean): void =>
        setRowCollapsed(row, !collapsed.has(row.node.pid), isRecursive);
    /**
     * The process list is a single Tab stop, so these keys are the only way to reach a row that is not the current one:
     * Up/Down/Home/End walk the visible rows, Left/Right collapse, expand, climb to the parent process, or step into
     * the first child, and Enter/Space flip the focused process the way clicking it does.
     */
    const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: ProcessTreeRow): void => {
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        const index = rows.indexOf(row);
        if (index === -1) return;
        if (isProcessVerticalKey(event.key)) {
            const nextIndex = nextProcessRowIndex(rows, index, event.key);
            if (nextIndex === undefined) return;
            event.preventDefault();
            focusRow(rows[nextIndex].node.pid);
            return;
        }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            const intent = processRowHorizontalIntent(rows, index, event.key);
            if (intent.collapsed !== undefined) {
                event.preventDefault();
                setRowCollapsed(row, intent.collapsed);
            }
            if (intent.focusIndex !== undefined) {
                event.preventDefault();
                focusRow(rows[intent.focusIndex].node.pid);
            }
            return;
        }
        if ((event.key === 'Enter' || event.key === ' ') && row.isExpandable) {
            event.preventDefault();
            toggle(row, false);
        }
    };
    return (
        <TooltipProvider>
            <main
                className="process-explorer grid h-full w-full grid-rows-[42px_minmax(0,1fr)] bg-background"
                data-sampled-at={snapshot?.sampledAt}
            >
                <header className="process-titlebar relative flex items-center justify-center bg-title-bar-active-background px-12 pl-[84px] text-title-bar-active-foreground [-webkit-app-region:drag] window-inactive:bg-title-bar-inactive-background window-inactive:text-title-bar-inactive-foreground">
                    <strong className="overflow-hidden text-[12px] text-ellipsis whitespace-nowrap">
                        Process Explorer — Caxri
                    </strong>
                    <button
                        type="button"
                        className="absolute right-3 grid size-[26px] cursor-pointer place-items-center rounded border-0 bg-transparent p-0 text-muted [-webkit-app-region:no-drag] hover:bg-elevated hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-foreground disabled:cursor-default disabled:opacity-55"
                        aria-label="Refresh processes"
                        title="Refresh processes"
                        disabled={refreshing}
                        onClick={refresh}
                    >
                        <RefreshCw
                            className={cn(
                                refreshing && 'animate-[process-spin_900ms_linear_infinite]',
                            )}
                            size={15}
                        />
                    </button>
                </header>
                <div
                    ref={gridReference}
                    className="process-grid min-h-0 overflow-auto"
                    role="treegrid"
                    aria-label="Caxri processes"
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
                                const pid =
                                    event.target instanceof HTMLElement
                                        ? event.target.closest<HTMLElement>('[data-process-pid]')
                                              ?.dataset.processPid
                                        : undefined;
                                if (pid) setFocusedPid(Number(pid));
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
                                    {error}
                                </div>
                            )}
                            {snapshot && roots.length === 0 && (
                                <div className={processMessageClassName}>
                                    No Caxri processes found.
                                </div>
                            )}
                            {rows.map((row) => (
                                <ProcessRow
                                    key={row.node.pid}
                                    isRoving={row.node.pid === rovingPid}
                                    row={row}
                                    onKeyDown={handleRowKeyDown}
                                    onToggle={toggle}
                                />
                            ))}
                        </div>
                    </div>
                </div>
            </main>
        </TooltipProvider>
    );
}
