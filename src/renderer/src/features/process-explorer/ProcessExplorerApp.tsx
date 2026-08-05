import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { ProcessExplorerSnapshot } from '@shared/process-explorer';

import { applyCssTheme } from '../../lib/theme-css';
import { buildProcessTree, type ProcessTreeNode } from './process-tree';

const SAMPLE_INTERVAL_MS = 2_000;

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
    const expandable = node.children.length > 0;
    const expanded = expandable && !collapsed.has(node.pid);
    return (
        <>
            <div
                className="process-row"
                role="row"
                aria-level={depth + 1}
                aria-expanded={expandable ? expanded : undefined}
                data-process-pid={node.pid}
            >
                <div
                    role="gridcell"
                    className="process-name-cell"
                    style={{ paddingLeft: 14 + depth * 20 }}
                >
                    <button
                        type="button"
                        className="process-name"
                        title={node.name}
                        disabled={!expandable}
                        onClick={() => toggle(node.pid)}
                    >
                        {expandable ? (
                            expanded ? (
                                <ChevronDown size={14} />
                            ) : (
                                <ChevronRight size={14} />
                            )
                        ) : (
                            <span className="process-indent" />
                        )}
                        <span>{node.name}</span>
                    </button>
                </div>
                <span role="gridcell">{node.cpuPercent.toFixed(1)}</span>
                <span role="gridcell">{node.memoryMb.toFixed(1)}</span>
                <span role="gridcell">{node.pid}</span>
            </div>
            {expanded &&
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
        void window.processExplorer
            .snapshot()
            .then((nextSnapshot) => {
                setSnapshot(nextSnapshot);
                setError(undefined);
            })
            .catch((failure: unknown) =>
                setError(failure instanceof Error ? failure.message : 'Unable to sample processes'),
            )
            .finally(() => setRefreshing(false));
    }, []);
    useEffect(() => {
        const initialRefresh = window.setTimeout(refresh, 0);
        const interval = window.setInterval(refresh, SAMPLE_INTERVAL_MS);
        void window.processExplorer
            .theme()
            .then(applyCssTheme)
            .catch(() => undefined);
        return () => {
            window.clearTimeout(initialRefresh);
            window.clearInterval(interval);
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
        <main className="process-explorer" data-sampled-at={snapshot?.sampledAt}>
            <header className="process-titlebar">
                <strong>Process Explorer — Caxri</strong>
                <button
                    type="button"
                    aria-label="Refresh processes"
                    title="Refresh processes"
                    disabled={refreshing}
                    onClick={refresh}
                >
                    <RefreshCw className={refreshing ? 'spinning' : undefined} size={15} />
                </button>
            </header>
            <div className="process-grid" role="treegrid" aria-label="Caxri processes">
                <div className="process-header" role="row">
                    <strong role="columnheader">Process Name</strong>
                    <strong role="columnheader">CPU (%)</strong>
                    <strong role="columnheader">Memory (MB)</strong>
                    <strong role="columnheader">PID</strong>
                </div>
                <div className="process-rows">
                    {!snapshot && !error && (
                        <div className="process-message">Loading processes…</div>
                    )}
                    {error && <div className="process-message process-error">{error}</div>}
                    {snapshot && roots.length === 0 && (
                        <div className="process-message">No Caxri processes found.</div>
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
