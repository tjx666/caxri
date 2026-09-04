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
