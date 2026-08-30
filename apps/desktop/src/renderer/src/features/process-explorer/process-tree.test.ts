import { describe, expect, it } from 'vitest';

import { buildProcessTree, setProcessSubtreeCollapsed } from './process-tree';

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
});
