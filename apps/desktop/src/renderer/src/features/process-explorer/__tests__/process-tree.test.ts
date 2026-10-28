import type { TerminalProcessEntry } from '@caxri/protocol';
import type { ProcessExplorerEntry } from '@desktop-shared/process-explorer';
import { describe, expect, it } from 'vitest';

import type { ProcessTreeNode } from '../process-tree';
import {
    buildProcessTree,
    CAXRI_GROUP_ID,
    filterProcessTree,
    flattenProcessTree,
    nextProcessRowIndex,
    OTHER_PTY_GROUP_ID,
    processExplorerTotals,
    processRowHorizontalIntent,
    rovingProcessRowId,
    SESSIONS_GROUP_ID,
    setProcessNodeExpanded,
    setProcessSubtreeExpanded,
} from '../process-tree';

function process(
    pid: number,
    parentPid: number,
    name: string,
    overrides: Partial<ProcessExplorerEntry> = {},
): ProcessExplorerEntry {
    return { pid, parentPid, name, kind: 'process', cpuPercent: 1, memoryMb: 10, ...overrides };
}

const terminal: TerminalProcessEntry = {
    terminalId: 'terminal-1',
    sessionId: 'session-1',
    sessionTitle: 'Tune the timeline',
    kind: 'claude',
    provider: 'claude',
    title: 'Claude',
    processId: 40,
};

const processes = [
    process(10, 1, 'Caxri', { kind: 'main', cpuPercent: 5, memoryMb: 200 }),
    process(20, 10, 'Server Core', { kind: 'service', cpuPercent: 2, memoryMb: 100 }),
    process(30, 20, 'Terminal Host', { kind: 'service' }),
    process(40, 30, 'zsh', { command: '/bin/zsh -l' }),
    process(41, 40, 'claude', { cpuPercent: 250, memoryMb: 4_000, command: 'claude --resume' }),
    process(42, 41, 'node'),
];

function byId(roots: readonly ProcessTreeNode[], id: string): ProcessTreeNode | undefined {
    for (const root of roots) {
        if (root.id === id) return root;
        const found = byId(root.children, id);
        if (found) return found;
    }
    return undefined;
}

describe('buildProcessTree', () => {
    it('moves a Terminal process tree under its Session and lists the rest flat under Caxri', () => {
        const roots = buildProcessTree({ processes, terminals: [terminal] });
        expect(roots.map((root) => root.id)).toEqual([SESSIONS_GROUP_ID, CAXRI_GROUP_ID]);
        const [session] = roots[0].children;
        expect(session).toMatchObject({ kind: 'session', name: 'Tune the timeline' });
        const [terminalNode] = session.children;
        expect(terminalNode).toMatchObject({
            kind: 'terminal',
            name: 'Claude',
            tag: '3 processes',
            terminalId: 'terminal-1',
            cpuPercent: 252,
            memoryMb: 4_020,
            defaultCollapsed: true,
        });
        expect(terminalNode.children.map((child) => child.pid)).toEqual([40]);
        expect(
            roots[1].children
                .map((child) => child.name)
                .toSorted((left, right) => left.localeCompare(right)),
        ).toEqual(['Caxri', 'Server Core', 'Terminal Host']);
        expect(roots[1].children.every((child) => child.children.length === 0)).toBe(true);
        expect(byId(roots, 'pid:10')?.tag).toBe('Main process');
    });

    it('flags a Terminal and its Session above the resource alert thresholds', () => {
        const heavy = processes.map((entry) =>
            entry.pid === 41 ? { ...entry, cpuPercent: 350 } : entry,
        );
        const roots = buildProcessTree({ processes: heavy, terminals: [terminal] });
        expect(byId(roots, 'terminal:terminal-1')?.isHigh).toBe(true);
        expect(byId(roots, 'session:session-1')?.isHigh).toBe(true);
        expect(
            byId(buildProcessTree({ processes, terminals: [terminal] }), 'terminal:terminal-1'),
        ).toMatchObject({ isHigh: false });
    });

    it('keeps every process under Caxri when no Terminal is running', () => {
        const roots = buildProcessTree({ processes, terminals: [] });
        expect(roots.map((root) => root.id)).toEqual([CAXRI_GROUP_ID]);
        expect(roots[0].children).toHaveLength(processes.length);
    });

    it('sorts siblings by the chosen column', () => {
        const roots = buildProcessTree(
            { processes, terminals: [] },
            { column: 'memory', direction: 'descending' },
        );
        expect(roots[0].children.slice(0, 2).map((child) => child.name)).toEqual([
            'claude',
            'Caxri',
        ]);
    });

    it('counts a Terminal PTY master on its row and rolls PTY use up to the Session', () => {
        const withPty = processes.map((entry) =>
            entry.pid === 41 ? { ...entry, ptyCount: 2 } : entry,
        );
        const roots = buildProcessTree({ processes: withPty, terminals: [terminal] });
        expect(byId(roots, 'terminal:terminal-1')?.ptyCount).toBe(3);
        expect(byId(roots, 'session:session-1')?.ptyCount).toBe(3);
        expect(byId(roots, 'pid:41')?.ptyCount).toBe(2);
        expect(byId(roots, 'pid:30')?.ptyCount).toBe(0);
    });

    it('lists PTY holders outside Caxri in a separate group', () => {
        const roots = buildProcessTree({
            processes,
            terminals: [],
            otherPtyHolders: [
                process(900, 1, 'Ghostty', { ptyCount: 4 }),
                process(901, 1, 'tmux', { ptyCount: 7 }),
            ],
        });
        expect(roots.map((root) => root.id)).toEqual([CAXRI_GROUP_ID, OTHER_PTY_GROUP_ID]);
        expect(roots[1]).toMatchObject({ kind: 'group', name: 'Other apps', ptyCount: 11 });
    });

    it('sorts by PTY count', () => {
        const roots = buildProcessTree(
            {
                processes: [],
                terminals: [],
                otherPtyHolders: [
                    process(900, 1, 'Ghostty', { ptyCount: 4 }),
                    process(901, 1, 'tmux', { ptyCount: 7 }),
                ],
            },
            { column: 'pty', direction: 'descending' },
        );
        expect(roots[0].children.map((child) => child.name)).toEqual(['tmux', 'Ghostty']);
    });
});

describe('filterProcessTree', () => {
    const roots = buildProcessTree({ processes, terminals: [terminal] });

    it('keeps matching rows with their ancestors and drops the rest', () => {
        const filtered = filterProcessTree(roots, 'resume');
        expect(filtered.map((root) => root.id)).toEqual([SESSIONS_GROUP_ID]);
        expect(byId(filtered, 'terminal:terminal-1')).toBeDefined();
        expect(byId(filtered, 'pid:41')).toBeDefined();
        expect(byId(filtered, 'pid:10')).toBeUndefined();
    });

    it('keeps the whole subtree of a matching Session', () => {
        const filtered = filterProcessTree(roots, 'timeline');
        expect(byId(filtered, 'pid:42')).toBeDefined();
    });

    it('returns every root for a blank query', () => {
        expect(filterProcessTree(roots, '  ')).toEqual(roots);
    });
});

describe('flattenProcessTree', () => {
    const roots = buildProcessTree({ processes, terminals: [terminal] });

    it('starts Terminal rows folded and everything else open', () => {
        const rows = flattenProcessTree(roots, new Set());
        const terminalRow = rows.find((row) => row.node.kind === 'terminal');
        expect(terminalRow).toMatchObject({ isExpandable: true, isExpanded: false, depth: 2 });
        expect(rows.some((row) => row.node.pid === 40)).toBe(false);
    });

    it('expands a folded row and its subtree through the toggled set', () => {
        const terminalNode = byId(roots, 'terminal:terminal-1')!;
        const opened = setProcessNodeExpanded(new Set(), terminalNode, true);
        expect(flattenProcessTree(roots, opened).some((row) => row.node.pid === 40)).toBe(true);
        expect(setProcessNodeExpanded(opened, terminalNode, false).size).toBe(0);
        const subtree = setProcessSubtreeExpanded(new Set(), terminalNode, true);
        expect(flattenProcessTree(roots, subtree).some((row) => row.node.pid === 42)).toBe(true);
    });

    it('opens every row while a filter forces expansion', () => {
        const rows = flattenProcessTree(roots, new Set(), true);
        expect(rows.some((row) => row.node.pid === 42)).toBe(true);
    });
});

describe('keyboard helpers', () => {
    const roots = buildProcessTree({ processes, terminals: [terminal] });
    const rows = flattenProcessTree(roots, new Set());

    it('moves vertically without wrapping', () => {
        expect(nextProcessRowIndex(rows, 0, 'ArrowUp')).toBeUndefined();
        expect(nextProcessRowIndex(rows, 0, 'ArrowDown')).toBe(1);
        expect(nextProcessRowIndex(rows, 0, 'End')).toBe(rows.length - 1);
    });

    it('expands, steps in, folds, and climbs horizontally', () => {
        const terminalIndex = rows.findIndex((row) => row.node.kind === 'terminal');
        expect(processRowHorizontalIntent(rows, terminalIndex, 'ArrowRight')).toEqual({
            expanded: true,
        });
        expect(processRowHorizontalIntent(rows, terminalIndex, 'ArrowLeft')).toEqual({
            focusIndex: rows[terminalIndex].parentIndex,
        });
        expect(processRowHorizontalIntent(rows, 0, 'ArrowRight')).toEqual({ focusIndex: 1 });
        expect(processRowHorizontalIntent(rows, 0, 'ArrowLeft')).toEqual({ expanded: false });
    });

    it('keeps the roving Tab stop on a row that is still visible', () => {
        expect(rovingProcessRowId(rows, 'pid:20')).toBe('pid:20');
        expect(rovingProcessRowId(rows, 'pid:999')).toBe(SESSIONS_GROUP_ID);
        expect(rovingProcessRowId([], undefined)).toBeUndefined();
    });
});

describe('processExplorerTotals', () => {
    it('sums the sampled processes', () => {
        expect(processExplorerTotals(processes)).toEqual({
            cpuPercent: 260,
            memoryMb: 4_330,
            processCount: 6,
        });
    });
});
