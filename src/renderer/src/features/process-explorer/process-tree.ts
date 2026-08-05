import type { ProcessExplorerEntry } from '@shared/process-explorer';

export interface ProcessTreeNode extends ProcessExplorerEntry {
    children: ProcessTreeNode[];
}

export function buildProcessTree(processes: ProcessExplorerEntry[]): ProcessTreeNode[] {
    const nodes = new Map<number, ProcessTreeNode>();
    for (const process of processes) nodes.set(process.pid, { ...process, children: [] });
    const roots: ProcessTreeNode[] = [];
    for (const node of nodes.values()) {
        const parent = nodes.get(node.parentPid);
        if (parent && parent !== node) parent.children.push(node);
        else roots.push(node);
    }
    const sort = (siblings: ProcessTreeNode[]): void => {
        siblings.sort((left, right) => left.pid - right.pid);
        for (const node of siblings) sort(node.children);
    };
    sort(roots);
    return roots;
}
