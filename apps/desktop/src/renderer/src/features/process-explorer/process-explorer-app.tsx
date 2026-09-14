import { useCallback, useEffect, useMemo, useState } from 'react';

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
import type { ProcessTreeNode } from './process-tree';
import { buildProcessTree, setProcessSubtreeCollapsed } from './process-tree';
import { useProcessTableState } from './use-process-table-state';

const SAMPLE_INTERVAL_MS = 2_000;

const processMessageClassName = 'process-message grid min-h-[120px] place-items-center text-muted';

export function ProcessExplorerApp() {
    const [snapshot, setSnapshot] = useState<ProcessExplorerSnapshot>();
    const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
    const [error, setError] = useState<string>();
    const [refreshing, setRefreshing] = useState(false);
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
    const toggle = (node: ProcessTreeNode, isRecursive: boolean): void =>
        setCollapsed((current) => {
            if (isRecursive)
                return setProcessSubtreeCollapsed(current, node, !current.has(node.pid));
            const next = new Set(current);
            if (next.has(node.pid)) next.delete(node.pid);
            else next.add(node.pid);
            return next;
        });
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
                        <div className="process-rows" role="presentation">
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
                            {roots.map((node) => (
                                <ProcessRow
                                    key={node.pid}
                                    node={node}
                                    depth={0}
                                    collapsed={collapsed}
                                    toggle={toggle}
                                />
                            ))}
                        </div>
                    </div>
                </div>
            </main>
        </TooltipProvider>
    );
}
