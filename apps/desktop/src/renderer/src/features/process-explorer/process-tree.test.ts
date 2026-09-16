import type { ProcessExplorerEntry } from '@desktop-shared/process-explorer';
import { describe, expect, it } from 'vitest';

import {
    buildProcessTree,
    compareProcesses,
    flattenProcessTree,
    nextProcessRowIndex,
    processRowHorizontalIntent,
    rovingProcessRowPid,
    setProcessSubtreeCollapsed,
} from './process-tree';

/**
 * One root with four children whose CPU, memory, and name orders all disagree with the PID order, so a sort assertion
 * cannot pass by accident.
 */
const sortableProcesses: ProcessExplorerEntry[] = [
    { pid: 1, parentPid: 0, name: 'caxri', cpuPercent: 0, memoryMb: 250 },
    { pid: 10, parentPid: 1, name: 'zygote', cpuPercent: 0.5, memoryMb: 40 },
    { pid: 11, parentPid: 1, name: 'agent', cpuPercent: 12, memoryMb: 480 },
    { pid: 12, parentPid: 1, name: 'gpu-process', cpuPercent: 0, memoryMb: 140 },
    { pid: 13, parentPid: 11, name: 'nested', cpuPercent: 99, memoryMb: 999 },
];

function childPids(sort: Parameters<typeof buildProcessTree>[1]): number[] {
    return buildProcessTree(sortableProcesses, sort)[0].children.map(({ pid }) => pid);
}

describe('buildProcessTree', () => {
    it('builds stable nested rows and keeps missing parents as roots', () => {
        const tree = buildProcessTree([
            { pid: 3, parentPid: 2, name: 'shell', cpuPercent: 0, memoryMb: 2 },
            { pid: 1, parentPid: 0, name: 'caxri', cpuPercent: 1, memoryMb: 10 },
            { pid: 4, parentPid: 99, name: 'orphan', cpuPercent: 0, memoryMb: 1 },
            { pid: 2, parentPid: 1, name: 'runtime', cpuPercent: 0, memoryMb: 4 },
        ]);

        expect(tree.map(({ pid }) => pid)).toEqual([1, 4]);
        // `children` here is the plain ProcessTree node array from `buildProcessTree`, not a DOM
        // collection; `.firstElementChild` does not apply.
        // eslint-disable-next-line unicorn/better-dom-traversing -- see above
        expect(tree[0].children[0]).toMatchObject({ pid: 2 });
        // eslint-disable-next-line unicorn/better-dom-traversing -- same non-DOM `children` array, see above
        expect(tree[0].children[0].children[0]).toMatchObject({ pid: 3 });
    });

    it('updates every expandable node in a process subtree without changing siblings', () => {
        const [root, sibling] = buildProcessTree([
            { pid: 1, parentPid: 0, name: 'root', cpuPercent: 0, memoryMb: 1 },
            { pid: 2, parentPid: 1, name: 'child', cpuPercent: 0, memoryMb: 1 },
            { pid: 3, parentPid: 2, name: 'leaf', cpuPercent: 0, memoryMb: 1 },
            { pid: 4, parentPid: 0, name: 'sibling', cpuPercent: 0, memoryMb: 1 },
            { pid: 5, parentPid: 4, name: 'sibling leaf', cpuPercent: 0, memoryMb: 1 },
        ]);
        const initial = new Set([sibling.pid]);

        const collapsed = setProcessSubtreeCollapsed(initial, root, true);
        const expanded = setProcessSubtreeCollapsed(collapsed, root, false);

        expect(collapsed).toEqual(new Set([sibling.pid, root.pid, root.children.at(0)!.pid]));
        expect(expanded).toEqual(initial);
        expect(initial).toEqual(new Set([sibling.pid]));
    });

    it('defaults to ascending PID', () => {
        expect(childPids(undefined)).toEqual([10, 11, 12]);
    });

    it('orders siblings by every column in both directions', () => {
        expect(childPids({ column: 'cpu', direction: 'descending' })).toEqual([11, 10, 12]);
        expect(childPids({ column: 'memory', direction: 'descending' })).toEqual([11, 12, 10]);
        expect(childPids({ column: 'memory', direction: 'ascending' })).toEqual([10, 12, 11]);
        expect(childPids({ column: 'name', direction: 'ascending' })).toEqual([11, 12, 10]);
        expect(childPids({ column: 'pid', direction: 'descending' })).toEqual([12, 11, 10]);
    });

    it('keeps children nested under their parent whatever the sort', () => {
        const [root] = buildProcessTree(sortableProcesses, {
            column: 'memory',
            direction: 'descending',
        });

        const agent = root.children.find(({ pid }) => pid === 11)!;
        // The heaviest process in the sample is pid 13, and it stays a child of pid 11 rather than climbing to the top.
        expect(root.pid).toBe(1);
        expect(agent.children.map(({ pid }) => pid)).toEqual([13]);
    });
});

describe('compareProcesses', () => {
    const left: ProcessExplorerEntry = {
        pid: 7,
        parentPid: 1,
        name: 'same',
        cpuPercent: 0,
        memoryMb: 1,
    };
    const right: ProcessExplorerEntry = { ...left, pid: 3 };

    it('breaks a tie by ascending PID in either direction', () => {
        expect(compareProcesses(left, right, { column: 'cpu', direction: 'ascending' })).toBe(4);
        expect(compareProcesses(left, right, { column: 'cpu', direction: 'descending' })).toBe(4);
    });
});

/**
 * One root with a child that has a child of its own, so a row can be a parent and a child at once — the shape Left and
 * Right have to walk in both directions.
 */
const nestedProcesses: ProcessExplorerEntry[] = [
    { pid: 1, parentPid: 0, name: 'caxri', cpuPercent: 0, memoryMb: 10 },
    { pid: 2, parentPid: 1, name: 'server-core', cpuPercent: 0, memoryMb: 20 },
    { pid: 3, parentPid: 2, name: 'agent', cpuPercent: 0, memoryMb: 30 },
    { pid: 4, parentPid: 0, name: 'orphan', cpuPercent: 0, memoryMb: 5 },
];

function nestedRows(collapsed: Iterable<number> = []) {
    return flattenProcessTree(buildProcessTree(nestedProcesses), new Set(collapsed));
}

describe('flattenProcessTree', () => {
    it('emits the visible rows in render order with their depth and sibling position', () => {
        const rows = nestedRows();

        expect(rows.map((row) => row.node.pid)).toEqual([1, 2, 3, 4]);
        expect(rows[0]).toMatchObject({
            depth: 0,
            isExpandable: true,
            isExpanded: true,
            parentIndex: -1,
            positionInSet: 1,
            setSize: 2,
        });
        expect(rows[2]).toMatchObject({
            depth: 2,
            isExpandable: false,
            isExpanded: false,
            parentIndex: 1,
            positionInSet: 1,
            setSize: 1,
        });
    });

    it('drops the descendants of a collapsed process so focus can never land on a hidden row', () => {
        expect(nestedRows([2]).map((row) => row.node.pid)).toEqual([1, 2, 4]);
        expect(nestedRows([1]).map((row) => row.node.pid)).toEqual([1, 4]);
    });
});

describe('nextProcessRowIndex', () => {
    const rows = nestedRows();

    it('moves Down and Up by one row', () => {
        expect(nextProcessRowIndex(rows, 0, 'ArrowDown')).toBe(1);
        expect(nextProcessRowIndex(rows, 1, 'ArrowUp')).toBe(0);
    });

    it('stops at either edge instead of wrapping', () => {
        expect(nextProcessRowIndex(rows, 0, 'ArrowUp')).toBeUndefined();
        expect(nextProcessRowIndex(rows, rows.length - 1, 'ArrowDown')).toBeUndefined();
    });

    it('jumps to the first or last row on Home/End', () => {
        expect(nextProcessRowIndex(rows, 2, 'Home')).toBe(0);
        expect(nextProcessRowIndex(rows, 1, 'End')).toBe(rows.length - 1);
    });

    it('returns undefined while the sample has no rows', () => {
        expect(nextProcessRowIndex([], 0, 'ArrowDown')).toBeUndefined();
    });
});

describe('processRowHorizontalIntent', () => {
    it('expands a collapsed process on Right and then steps into its first child', () => {
        expect(processRowHorizontalIntent(nestedRows([1]), 0, 'ArrowRight')).toEqual({
            collapsed: false,
        });
        expect(processRowHorizontalIntent(nestedRows(), 0, 'ArrowRight')).toEqual({
            focusIndex: 1,
        });
    });

    it('does nothing on Right for a leaf process', () => {
        const rows = nestedRows();
        expect(processRowHorizontalIntent(rows, 2, 'ArrowRight')).toEqual({});
        expect(processRowHorizontalIntent(rows, 3, 'ArrowRight')).toEqual({});
    });

    it('collapses an open process on Left and climbs to the parent from a child', () => {
        const rows = nestedRows();
        expect(processRowHorizontalIntent(rows, 1, 'ArrowLeft')).toEqual({ collapsed: true });
        expect(processRowHorizontalIntent(rows, 2, 'ArrowLeft')).toEqual({ focusIndex: 1 });
    });

    it('does nothing on Left for a root process that is already closed', () => {
        expect(processRowHorizontalIntent(nestedRows([1]), 0, 'ArrowLeft')).toEqual({});
        expect(processRowHorizontalIntent(nestedRows(), 3, 'ArrowLeft')).toEqual({});
    });

    it('resolves to nothing for an index outside the list', () => {
        expect(processRowHorizontalIntent(nestedRows(), 99, 'ArrowRight')).toEqual({});
    });
});

describe('rovingProcessRowPid', () => {
    const rows = nestedRows();

    it('keeps the remembered process while it is still on screen', () => {
        expect(rovingProcessRowPid(rows, 3)).toBe(3);
    });

    it('falls back to the first row once that process has exited or collapsed out of view', () => {
        expect(rovingProcessRowPid(rows, 999)).toBe(1);
        expect(rovingProcessRowPid(nestedRows([1]), 2)).toBe(1);
        expect(rovingProcessRowPid(rows, undefined)).toBe(1);
    });

    it('returns undefined while the sample has no rows', () => {
        expect(rovingProcessRowPid([], 1)).toBeUndefined();
    });
});
