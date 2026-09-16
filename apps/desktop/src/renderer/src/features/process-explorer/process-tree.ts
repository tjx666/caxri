import { collectTreeSubtree } from '@caxri/utils';
import type { ProcessExplorerEntry } from '@desktop-shared/process-explorer';

import type { ProcessColumnKey, ProcessSort } from './process-columns';
import { DEFAULT_PROCESS_SORT } from './process-columns';

export interface ProcessTreeNode extends ProcessExplorerEntry {
    children: ProcessTreeNode[];
}

export function setProcessSubtreeCollapsed(
    current: ReadonlySet<number>,
    root: ProcessTreeNode,
    isCollapsed: boolean,
): Set<number> {
    const next = new Set(current);
    const subtree = collectTreeSubtree(root, (candidate) => candidate.children);
    for (const node of subtree) {
        if (node.children.length === 0) continue;
        if (isCollapsed) next.add(node.pid);
        else next.delete(node.pid);
    }
    return next;
}

function compareProcessColumn(
    left: ProcessExplorerEntry,
    right: ProcessExplorerEntry,
    column: ProcessColumnKey,
): number {
    switch (column) {
        case 'cpu': {
            return left.cpuPercent - right.cpuPercent;
        }
        case 'memory': {
            return left.memoryMb - right.memoryMb;
        }
        case 'name': {
            return left.name.localeCompare(right.name, undefined, {
                numeric: true,
                sensitivity: 'base',
            });
        }
        case 'pid': {
            return left.pid - right.pid;
        }
    }
}

/**
 * Ties fall back to ascending PID rather than to the sampler's order, so two processes reporting the same 0.0% CPU
 * never swap places between two-second samples.
 */
export function compareProcesses(
    left: ProcessExplorerEntry,
    right: ProcessExplorerEntry,
    sort: ProcessSort,
): number {
    const compared = compareProcessColumn(left, right, sort.column);
    if (compared === 0) return left.pid - right.pid;
    return sort.direction === 'ascending' ? compared : -compared;
}

/**
 * Sorting reorders siblings only; a child never leaves its parent. Flattening the tree would answer "which process is
 * heaviest" while destroying the ownership chain that makes the answer actionable — the same trade-off Windows Task
 * Manager makes in its process view.
 */
export function buildProcessTree(
    processes: ProcessExplorerEntry[],
    sort: ProcessSort = DEFAULT_PROCESS_SORT,
): ProcessTreeNode[] {
    const nodes = new Map<number, ProcessTreeNode>();
    for (const process of processes) nodes.set(process.pid, { ...process, children: [] });
    const roots: ProcessTreeNode[] = [];
    for (const node of nodes.values()) {
        const parent = nodes.get(node.parentPid);
        if (parent && parent !== node) parent.children.push(node);
        else roots.push(node);
    }
    const sortSiblings = (siblings: ProcessTreeNode[]): ProcessTreeNode[] =>
        siblings
            .toSorted((left, right) => compareProcesses(left, right, sort))
            .map((node) => ({ ...node, children: sortSiblings(node.children) }));
    return sortSiblings(roots);
}

export interface ProcessTreeRow {
    depth: number;
    /**
     * True when the process has children, which is what makes the row a disclosure target.
     */
    isExpandable: boolean;
    isExpanded: boolean;
    node: ProcessTreeNode;
    /**
     * Flat index of the parent row, or `-1` for a root process.
     */
    parentIndex: number;
    /**
     * 1-based position among sibling rows (`aria-posinset`).
     */
    positionInSet: number;
    /**
     * Number of sibling rows including this one (`aria-setsize`).
     */
    setSize: number;
}

/**
 * Flattens the process tree into exactly the rows on screen, in render order, so one Tab stop plus arrow keys can walk
 * them. Depth, parent index, and sibling position are precomputed here because a row rendered from a flat list cannot
 * work them out from its own node, and the keyboard math needs all three.
 */
export function flattenProcessTree(
    roots: readonly ProcessTreeNode[],
    collapsed: ReadonlySet<number>,
): ProcessTreeRow[] {
    const rows: ProcessTreeRow[] = [];
    const append = (
        siblings: readonly ProcessTreeNode[],
        depth: number,
        parentIndex: number,
    ): void => {
        for (const [index, node] of siblings.entries()) {
            const isExpandable = node.children.length > 0;
            const isExpanded = isExpandable && !collapsed.has(node.pid);
            const rowIndex = rows.length;
            rows.push({
                depth,
                isExpandable,
                isExpanded,
                node,
                parentIndex,
                positionInSet: index + 1,
                setSize: siblings.length,
            });
            if (isExpanded) append(node.children, depth + 1, rowIndex);
        }
    };
    append(roots, 0, -1);
    return rows;
}

export type ProcessRowVerticalKey = 'ArrowDown' | 'ArrowUp' | 'End' | 'Home';

/**
 * Returns the row index roving focus should move to for Up/Down/Home/End, or `undefined` when the key does not move
 * focus (no rows, or already at an edge — the list deliberately does not wrap).
 */
export function nextProcessRowIndex(
    rows: readonly ProcessTreeRow[],
    index: number,
    key: ProcessRowVerticalKey,
): number | undefined {
    if (rows.length === 0) return undefined;
    if (key === 'Home') return 0;
    if (key === 'End') return rows.length - 1;
    const nextIndex = index + (key === 'ArrowDown' ? 1 : -1);
    return nextIndex >= 0 && nextIndex < rows.length ? nextIndex : undefined;
}

export interface ProcessRowHorizontalIntent {
    /**
     * Present when Left/Right should flip this row's collapsed state.
     */
    collapsed?: boolean;
    /**
     * Present when Left/Right should move roving focus to another row.
     */
    focusIndex?: number;
}

/**
 * Resolves Left/Right per the standard hierarchical-navigation pattern: Right expands a collapsed process and steps
 * into its first child once it is open, Left collapses an open process and otherwise climbs to the parent process. A
 * leaf has neither children nor a disclosure, so Right on one does nothing at all.
 */
export function processRowHorizontalIntent(
    rows: readonly ProcessTreeRow[],
    index: number,
    key: 'ArrowLeft' | 'ArrowRight',
): ProcessRowHorizontalIntent {
    const row = rows.at(index);
    if (!row) return {};
    if (key === 'ArrowLeft') {
        if (row.isExpanded) return { collapsed: true };
        return row.parentIndex === -1 ? {} : { focusIndex: row.parentIndex };
    }
    if (!row.isExpandable) return {};
    if (!row.isExpanded) return { collapsed: false };
    // An expanded process renders its children directly below it, so the first child is always the next row; the
    // parent test keeps the step from walking onto a sibling if that ever stops being true.
    return rows.at(index + 1)?.parentIndex === index ? { focusIndex: index + 1 } : {};
}

/**
 * Resolves which row owns the single roving Tab stop. The sampler replaces the whole tree every two seconds and a
 * process can exit between samples, so a remembered PID is only used while it is still on screen; otherwise the Tab
 * stop falls back to the first row, exactly like a freshly opened window.
 */
export function rovingProcessRowPid(
    rows: readonly ProcessTreeRow[],
    focusedPid: number | undefined,
): number | undefined {
    if (focusedPid !== undefined && rows.some((row) => row.node.pid === focusedPid))
        return focusedPid;
    return rows[0]?.node.pid;
}
