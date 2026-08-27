import { useCallback, useEffect, useMemo, useState } from 'react';

import { errorMessage } from '@caxri/protocol';
import type { ProcessExplorerSnapshot } from '@desktop-shared/process-explorer';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';

import { createVisibilityAwarePoll } from '../../lib/poll-scheduler';
import { applyCssTheme } from '../../lib/theme-css';
import { cn } from '../../lib/utilities';
import type { ProcessTreeNode } from './process-tree';
import { buildProcessTree } from './process-tree';

const SAMPLE_INTERVAL_MS = 2_000;

const processHeaderCellClassName =
    'flex items-center px-3 border-l border-border text-[12px] font-semibold';
const processRowCellClassName = 'flex items-center px-3 border-l border-border tabular-nums';
const processMessageClassName = 'process-message grid min-h-[120px] place-items-center text-muted';

function ProcessRow({
    collapsed,
    depth,
    node,
    toggle,
}: {
    collapsed: Set<number>;
    depth: number;
    node: ProcessTreeNode;
    toggle: (pid: number) => void;
}) {
    const isExpandable = node.children.length > 0;
    const isExpanded = isExpandable && !collapsed.has(node.pid);
    return (
        <>
            <div
                className="process-row grid min-h-7 grid-cols-[minmax(320px,1fr)_110px_140px_90px] hover:bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)]"
                role="row"
                aria-level={depth + 1}
                aria-expanded={isExpandable ? isExpanded : undefined}
                data-process-pid={node.pid}
            >
                <div
                    role="gridcell"
                    className="process-name-cell flex min-w-0 items-center"
                    style={{ paddingLeft: 14 + depth * 20 }}
                >
                    <button
                        type="button"
                        className="process-name flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 overflow-hidden border-0 bg-transparent p-0 text-left focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-foreground disabled:cursor-default disabled:text-inherit"
                        title={node.name}
                        disabled={!isExpandable}
                        onClick={() => toggle(node.pid)}
                    >
                        {isExpandable ? (
                            isExpanded ? (
                                <ChevronDown className="w-3.5 shrink-0" size={14} />
                            ) : (
                                <ChevronRight className="w-3.5 shrink-0" size={14} />
                            )
                        ) : (
                            <span className="process-indent w-3.5 shrink-0" />
                        )}
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                            {node.name}
                        </span>
                    </button>
                </div>
                <span role="gridcell" className={processRowCellClassName}>
                    {node.cpuPercent.toFixed(1)}
                </span>
                <span role="gridcell" className={processRowCellClassName}>
                    {node.memoryMb.toFixed(1)}
                </span>
                <span role="gridcell" className={processRowCellClassName}>
                    {node.pid}
                </span>
            </div>
            {isExpanded &&
                node.children.map((child) => (
                    <ProcessRow
                        key={child.pid}
                        node={child}
                        depth={depth + 1}
                        collapsed={collapsed}
                        toggle={toggle}
                    />
                ))}
        </>
    );
}

export function ProcessExplorerApp() {
    const [snapshot, setSnapshot] = useState<ProcessExplorerSnapshot>();
    const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
    const [error, setError] = useState<string>();
    const [refreshing, setRefreshing] = useState(false);
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
    const roots = useMemo(() => buildProcessTree(snapshot?.processes ?? []), [snapshot?.processes]);
    const toggle = (pid: number): void =>
        setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(pid)) next.delete(pid);
            else next.add(pid);
            return next;
        });
    return (
        <main
            className="process-explorer grid h-full w-full grid-rows-[42px_minmax(0,1fr)] bg-background"
            data-sampled-at={snapshot?.sampledAt}
        >
            <header className="process-titlebar relative flex items-center justify-center bg-surface px-12 pl-[84px] [-webkit-app-region:drag]">
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
                        className={cn(refreshing && 'animate-[process-spin_900ms_linear_infinite]')}
                        size={15}
                    />
                </button>
            </header>
            <div
                className="process-grid grid min-h-0 grid-rows-[30px_minmax(0,1fr)]"
                role="treegrid"
                aria-label="Caxri processes"
            >
                <div
                    className="process-header grid grid-cols-[minmax(320px,1fr)_110px_140px_90px] border-b border-border bg-surface"
                    role="row"
                >
                    <span
                        role="columnheader"
                        className={cn(processHeaderCellClassName, 'border-l-0')}
                    >
                        Process Name
                    </span>
                    <span role="columnheader" className={processHeaderCellClassName}>
                        CPU (%)
                    </span>
                    <span role="columnheader" className={processHeaderCellClassName}>
                        Memory (MB)
                    </span>
                    <span role="columnheader" className={processHeaderCellClassName}>
                        PID
                    </span>
                </div>
                <div className="process-rows min-h-0 overflow-auto">
                    {!snapshot && !error && (
                        <div className={processMessageClassName}>Loading processes…</div>
                    )}
                    {error && (
                        <div className={cn(processMessageClassName, 'process-error text-danger')}>
                            {error}
                        </div>
                    )}
                    {snapshot && roots.length === 0 && (
                        <div className={processMessageClassName}>No Caxri processes found.</div>
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
        </main>
    );
}
