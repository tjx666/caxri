import type { TerminalProcessEntry } from '@caxri/protocol';
import { agentProviderCatalog, isTerminalResourceUsageHigh } from '@caxri/protocol';
import { collectTreeSubtree } from '@caxri/utils';
import type {
    ProcessExplorerEntry,
    ProcessExplorerKind,
    ProcessExplorerSnapshot,
} from '@desktop-shared/process-explorer';

import type { ProcessColumnKey, ProcessSort } from './process-columns';
import { DEFAULT_PROCESS_SORT } from './process-columns';

export type ProcessTreeNodeKind = ProcessExplorerKind | 'group' | 'session' | 'terminal';

/**
 * One row of the explorer. Grouping rows (`group`, `session`, `terminal`) carry the summed usage of everything under
 * them and no PID; process rows are the sampled OS processes.
 */
export interface ProcessTreeNode {
    children: ProcessTreeNode[];
    /**
     * Full redacted command line of a plain process, for hover and filtering.
     */
    command?: string;
    cpuPercent: number;
    /**
     * Terminal rows start folded, like the activity list in comparable tools: the Session and Agent already answer "who
     * is using this", and the process tree underneath is detail on demand.
     */
    defaultCollapsed: boolean;
    /**
     * Stable across samples so expansion and focus survive the two-second refresh.
     */
    id: string;
    /**
     * Above the shared Terminal resource alert thresholds; only Terminal and Session rows are judged.
     */
    isHigh: boolean;
    kind: ProcessTreeNodeKind;
    memoryMb: number;
    name: string;
    pid?: number;
    /**
     * Muted qualifier after the name: the process role, or how many processes a Terminal row stands for.
     */
    tag?: string;
    terminalId?: string;
}

export const SESSIONS_GROUP_ID = 'group:sessions';
export const CAXRI_GROUP_ID = 'group:caxri';

const KIND_TAGS: Partial<Record<ProcessExplorerKind, string>> = {
    helper: 'Helper',
    main: 'Main process',
    service: 'Service',
    window: 'Window',
};

function compareColumn(left: ProcessTreeNode, right: ProcessTreeNode, column: ProcessColumnKey) {
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
            return (left.pid ?? 0) - (right.pid ?? 0);
        }
    }
}

/**
 * Ties fall back to the stable id rather than to the sampler's order, so two processes reporting the same 0.0% CPU
 * never swap places between two-second samples.
 */
function compareProcessNodes(
    left: ProcessTreeNode,
    right: ProcessTreeNode,
    sort: ProcessSort,
): number {
    const compared = compareColumn(left, right, sort.column);
    if (compared !== 0) return sort.direction === 'ascending' ? compared : -compared;
    if (left.pid !== undefined && right.pid !== undefined) return left.pid - right.pid;
    return left.id.localeCompare(right.id);
}

function processNode(process: ProcessExplorerEntry): ProcessTreeNode {
    return {
        children: [],
        command: process.command,
        cpuPercent: process.cpuPercent,
        defaultCollapsed: false,
        id: `pid:${process.pid}`,
        isHigh: false,
        kind: process.kind,
        memoryMb: process.memoryMb,
        name: process.name,
        pid: process.pid,
        tag: KIND_TAGS[process.kind],
    };
}

function sumUsage(nodes: readonly ProcessTreeNode[]): { cpuPercent: number; memoryMb: number } {
    let cpuPercent = 0;
    let memoryMb = 0;
    for (const node of nodes) {
        cpuPercent += node.cpuPercent;
        memoryMb += node.memoryMb;
    }
    return { cpuPercent, memoryMb };
}

function countProcesses(node: ProcessTreeNode): number {
    return collectTreeSubtree(node, (candidate) => candidate.children).length;
}

/**
 * Sums a node's own usage with everything under it; used for Terminal rows, whose PTY root is a real process.
 */
function treeUsage(node: ProcessTreeNode): { cpuPercent: number; memoryMb: number } {
    return sumUsage(collectTreeSubtree(node, (candidate) => candidate.children));
}

function terminalDisplayName(terminal: TerminalProcessEntry): string {
    if (terminal.provider) return agentProviderCatalog[terminal.provider].displayName;
    return terminal.title || 'Terminal';
}

/**
 * Groups the sampled processes the way a user asks about them: which Session and Agent is using this, then everything
 * Caxri itself runs. A Terminal's PTY process tree moves under its Session; whatever no running Terminal claims stays
 * in the Caxri group as a flat list, because its parent chain (Main → Server Core → Terminal Host) is the same for
 * every row and says nothing a role label does not.
 */
export function buildProcessTree(
    snapshot: Pick<ProcessExplorerSnapshot, 'processes' | 'terminals'>,
    sort: ProcessSort = DEFAULT_PROCESS_SORT,
): ProcessTreeNode[] {
    const nodes = new Map(snapshot.processes.map((process) => [process.pid, processNode(process)]));
    for (const process of snapshot.processes) {
        const parent = nodes.get(process.parentPid);
        if (parent && process.parentPid !== process.pid)
            parent.children.push(nodes.get(process.pid)!);
    }
    const claimed = new Set<number>();
    const sessions = new Map<string, ProcessTreeNode>();
    for (const terminal of snapshot.terminals) {
        const root = nodes.get(terminal.processId);
        if (!root) continue;
        const subtree = collectTreeSubtree(root, (candidate) => candidate.children);
        for (const node of subtree) if (node.pid !== undefined) claimed.add(node.pid);
        const usage = treeUsage(root);
        const processCount = countProcesses(root);
        const terminalNode: ProcessTreeNode = {
            children: [root],
            ...usage,
            defaultCollapsed: true,
            id: `terminal:${terminal.terminalId}`,
            isHigh: isTerminalResourceUsageHigh(usage),
            kind: 'terminal',
            name: terminalDisplayName(terminal),
            tag: processCount > 1 ? `${processCount} processes` : undefined,
            terminalId: terminal.terminalId,
        };
        const session = sessions.get(terminal.sessionId) ?? {
            children: [],
            cpuPercent: 0,
            defaultCollapsed: false,
            id: `session:${terminal.sessionId}`,
            isHigh: false,
            kind: 'session' as const,
            memoryMb: 0,
            name: terminal.sessionTitle || 'Untitled Session',
        };
        session.children.push(terminalNode);
        session.cpuPercent += usage.cpuPercent;
        session.memoryMb += usage.memoryMb;
        session.isHigh ||= terminalNode.isHigh;
        sessions.set(terminal.sessionId, session);
    }
    const sortTree = (siblings: readonly ProcessTreeNode[]): ProcessTreeNode[] =>
        siblings
            .toSorted((left, right) => compareProcessNodes(left, right, sort))
            .map((node) => ({ ...node, children: sortTree(node.children) }));
    const sessionNodes = sortTree(sessions.values().toArray());
    const caxriNodes = sortTree(
        snapshot.processes
            .filter((process) => !claimed.has(process.pid))
            .map((process) => ({ ...nodes.get(process.pid)!, children: [] })),
    );
    const groups: ProcessTreeNode[] = [];
    if (sessionNodes.length > 0)
        groups.push({
            children: sessionNodes,
            ...sumUsage(sessionNodes),
            defaultCollapsed: false,
            id: SESSIONS_GROUP_ID,
            isHigh: false,
            kind: 'group',
            name: 'Sessions',
        });
    if (caxriNodes.length > 0)
        groups.push({
            children: caxriNodes,
            ...sumUsage(caxriNodes),
            defaultCollapsed: false,
            id: CAXRI_GROUP_ID,
            isHigh: false,
            kind: 'group',
            name: 'Caxri',
        });
    return groups;
}

function isQueryMatch(node: ProcessTreeNode, query: string): boolean {
    return (
        node.name.toLowerCase().includes(query) ||
        (node.command?.toLowerCase().includes(query) ?? false) ||
        (node.pid !== undefined && String(node.pid).includes(query))
    );
}

/**
 * Keeps a row when it matches or something under it does. A matching Session or Terminal keeps its whole subtree, so
 * filtering by a Session title still shows what that Session is running.
 */
export function filterProcessTree(
    roots: readonly ProcessTreeNode[],
    rawQuery: string,
): ProcessTreeNode[] {
    const query = rawQuery.trim().toLowerCase();
    if (!query) return [...roots];
    const visit = (node: ProcessTreeNode): ProcessTreeNode | undefined => {
        if (node.kind !== 'group' && isQueryMatch(node, query)) return node;
        const children = node.children.flatMap((child) => visit(child) ?? []);
        return children.length > 0 ? { ...node, children } : undefined;
    };
    return roots.flatMap((root) => visit(root) ?? []);
}

/**
 * Expansion is stored as the set of rows the user flipped away from their default, so a Terminal row that starts folded
 * and a process row that starts open share one piece of state.
 */
function isProcessNodeExpanded(node: ProcessTreeNode, toggled: ReadonlySet<string>): boolean {
    return node.defaultCollapsed ? toggled.has(node.id) : !toggled.has(node.id);
}

export function setProcessNodeExpanded(
    toggled: ReadonlySet<string>,
    node: ProcessTreeNode,
    isExpanded: boolean,
): Set<string> {
    const next = new Set(toggled);
    if (isExpanded === node.defaultCollapsed) next.add(node.id);
    else next.delete(node.id);
    return next;
}

export function setProcessSubtreeExpanded(
    toggled: ReadonlySet<string>,
    root: ProcessTreeNode,
    isExpanded: boolean,
): Set<string> {
    let next = new Set(toggled);
    const subtree = collectTreeSubtree(root, (candidate) => candidate.children);
    for (const node of subtree)
        if (node.children.length > 0) next = setProcessNodeExpanded(next, node, isExpanded);
    return next;
}

export interface ProcessTreeRow {
    depth: number;
    /**
     * True when the row has children, which is what makes it a disclosure target.
     */
    isExpandable: boolean;
    isExpanded: boolean;
    node: ProcessTreeNode;
    /**
     * Flat index of the parent row, or `-1` for a top-level row.
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
 * Flattens the tree into exactly the rows on screen, in render order, so one Tab stop plus arrow keys can walk them.
 * `isForcedExpanded` opens every row while a filter is active, so a match is never hidden inside a folded Terminal.
 */
export function flattenProcessTree(
    roots: readonly ProcessTreeNode[],
    toggled: ReadonlySet<string>,
    isForcedExpanded = false,
): ProcessTreeRow[] {
    const rows: ProcessTreeRow[] = [];
    const append = (
        siblings: readonly ProcessTreeNode[],
        depth: number,
        parentIndex: number,
    ): void => {
        for (const [index, node] of siblings.entries()) {
            const isExpandable = node.children.length > 0;
            const isExpanded =
                isExpandable && (isForcedExpanded || isProcessNodeExpanded(node, toggled));
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

export interface ProcessExplorerTotals {
    cpuPercent: number;
    memoryMb: number;
    processCount: number;
}

export function processExplorerTotals(
    processes: readonly ProcessExplorerEntry[],
): ProcessExplorerTotals {
    let cpuPercent = 0;
    let memoryMb = 0;
    for (const process of processes) {
        cpuPercent += process.cpuPercent;
        memoryMb += process.memoryMb;
    }
    return { cpuPercent, memoryMb, processCount: processes.length };
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
     * Present when Left/Right should flip this row's expanded state.
     */
    expanded?: boolean;
    /**
     * Present when Left/Right should move roving focus to another row.
     */
    focusIndex?: number;
}

/**
 * Resolves Left/Right per the standard hierarchical-navigation pattern: Right expands a folded row and steps into its
 * first child once it is open, Left folds an open row and otherwise climbs to the parent. A leaf has neither children
 * nor a disclosure, so Right on one does nothing at all.
 */
export function processRowHorizontalIntent(
    rows: readonly ProcessTreeRow[],
    index: number,
    key: 'ArrowLeft' | 'ArrowRight',
): ProcessRowHorizontalIntent {
    const row = rows.at(index);
    if (!row) return {};
    if (key === 'ArrowLeft') {
        if (row.isExpanded) return { expanded: false };
        return row.parentIndex === -1 ? {} : { focusIndex: row.parentIndex };
    }
    if (!row.isExpandable) return {};
    if (!row.isExpanded) return { expanded: true };
    // An expanded row renders its children directly below it, so the first child is always the next row; the parent
    // test keeps the step from walking onto a sibling if that ever stops being true.
    return rows.at(index + 1)?.parentIndex === index ? { focusIndex: index + 1 } : {};
}

/**
 * Resolves which row owns the single roving Tab stop. The sampler replaces the whole tree every two seconds and a
 * process can exit between samples, so a remembered row is only used while it is still on screen; otherwise the Tab
 * stop falls back to the first row, exactly like a freshly opened window.
 */
export function rovingProcessRowId(
    rows: readonly ProcessTreeRow[],
    focusedId: string | undefined,
): string | undefined {
    if (focusedId !== undefined && rows.some((row) => row.node.id === focusedId)) return focusedId;
    return rows[0]?.node.id;
}
