import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { ProcessExplorerSnapshot } from '@desktop-shared/process-explorer';

import { LoadingSkeleton } from '../../components/loading-skeleton';
import { Button } from '../../components/ui/button';
import { TooltipProvider } from '../../components/ui/tooltip';
import { useContainerWidth } from '../../hooks/use-container-width';
import { useTranslation } from '../../i18n';
import { createVisibilityAwarePoll } from '../../lib/poll-scheduler';
import { applyCssTheme } from '../../lib/theme-css';
import { cn } from '../../lib/utilities';
import {
    PROCESS_GRID_MIN_WIDTH,
    processColumnWidthStyle,
    resolveProcessColumnWidths,
} from './process-columns';
import { ProcessFooter } from './process-footer';
import { ProcessRow } from './process-row';
import { ProcessSummaryBar } from './process-summary-bar';
import { ProcessTableHeader } from './process-table-header';
import { ProcessTitleBar } from './process-title-bar';
import { buildProcessTree, filterProcessTree, processExplorerTotals } from './process-tree';
import { useProcessTableState } from './use-process-table-state';
import { useProcessTreeNavigation } from './use-process-tree-navigation';

const SAMPLE_INTERVAL_MS = 2_000;

/**
 * Kept as data rather than a sentence so the message follows a language change made while it is shown.
 */
type ProcessExplorerError = { kind: 'sample' } | { kind: 'stop'; name: string };

const processMessageClassName = 'process-message grid min-h-[120px] place-items-center text-muted';

/**
 * The one status line the list shows instead of rows: loading, a sampling failure with Retry, nothing sampled, or
 * nothing matching the filter.
 */
function ProcessListMessage({
    error,
    filter,
    hasProcesses,
    hasRows,
    hasSnapshot,
    isRefreshing,
    onRetry,
}: {
    error?: ProcessExplorerError;
    filter: string;
    hasProcesses: boolean;
    hasRows: boolean;
    hasSnapshot: boolean;
    isRefreshing: boolean;
    onRetry: () => void;
}) {
    const { t } = useTranslation();
    if (error)
        return (
            <div className={cn(processMessageClassName, 'process-error text-danger')}>
                <p role="alert">
                    {error.kind === 'sample'
                        ? t('processExplorer.error.sample')
                        : t('processExplorer.error.stop', { name: error.name })}
                </p>
                <Button
                    size="sm"
                    variant="secondary"
                    aria-disabled={isRefreshing}
                    onClick={onRetry}
                >
                    {t('common.retry')}
                </Button>
            </div>
        );
    if (!hasSnapshot)
        return (
            <LoadingSkeleton variant="list" label={t('processExplorer.list.loading')} rows={8} />
        );
    if (!hasProcesses)
        return <div className={processMessageClassName}>{t('processExplorer.list.empty')}</div>;
    if (!hasRows)
        return (
            <div className={processMessageClassName}>
                {t('processExplorer.list.noMatch', { filter: filter.trim() })}
            </div>
        );
    return null;
}

export function ProcessExplorerApp() {
    const { t } = useTranslation();
    const [snapshot, setSnapshot] = useState<ProcessExplorerSnapshot>();
    const [filter, setFilter] = useState('');
    const [error, setError] = useState<ProcessExplorerError>();
    const [refreshing, setRefreshing] = useState(false);
    const refreshInFlight = useRef(false);
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
                setError({ kind: 'sample' });
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
        () => (snapshot ? buildProcessTree(snapshot, table.sort, t) : []),
        [snapshot, t, table.sort],
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
    const stopTerminal = (terminalId: string, name: string): void => {
        async function runStop(): Promise<void> {
            try {
                await globalThis.processExplorer.stopTerminal(terminalId);
            } catch (error_: unknown) {
                console.error('processExplorer.stopTerminal failed', error_);
                setError({ kind: 'stop', name });
                return;
            }
            refresh();
        }
        // eslint-disable-next-line no-void -- intentional floating-promise discard, runStop reports its own failure
        void runStop();
    };
    const { handleRowKeyDown, handleRowsFocus, rovingId, rows, toggle } = useProcessTreeNavigation({
        isFiltering: filter.trim().length > 0,
        onStopTerminal: stopTerminal,
        roots: visibleRoots,
        rowsReference,
    });
    return (
        <TooltipProvider>
            <main
                className="process-explorer grid h-full w-full grid-rows-[42px_auto_minmax(0,1fr)_28px] bg-background"
                data-sampled-at={snapshot?.sampledAt}
            >
                <ProcessTitleBar isRefreshing={refreshing} onRefresh={refresh} />
                <ProcessSummaryBar
                    filter={filter}
                    snapshot={snapshot}
                    totals={totals}
                    onFilterChange={setFilter}
                />
                <div
                    ref={gridReference}
                    className="process-grid min-h-0 overflow-auto"
                    role="treegrid"
                    aria-label={t('processExplorer.gridLabel')}
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
                            onFocusCapture={handleRowsFocus}
                        >
                            <ProcessListMessage
                                error={error}
                                filter={filter}
                                hasProcesses={roots.length > 0}
                                hasRows={rows.length > 0}
                                hasSnapshot={snapshot !== undefined}
                                isRefreshing={refreshing}
                                onRetry={refresh}
                            />
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
                <ProcessFooter
                    intervalSeconds={SAMPLE_INTERVAL_MS / 1_000}
                    isLive={snapshot !== undefined && !error}
                    sampledAt={snapshot?.sampledAt}
                />
            </main>
        </TooltipProvider>
    );
}
