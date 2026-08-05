import { describe, expect, it } from 'vitest';

import { buildProcessTree } from './process-tree';

describe('buildProcessTree', () => {
    it('builds stable nested rows and keeps missing parents as roots', () => {
        const tree = buildProcessTree([
            { pid: 3, parentPid: 2, name: 'shell', cpuPercent: 0, memoryMb: 2 },
            { pid: 1, parentPid: 0, name: 'caxri', cpuPercent: 1, memoryMb: 10 },
            { pid: 4, parentPid: 99, name: 'orphan', cpuPercent: 0, memoryMb: 1 },
            { pid: 2, parentPid: 1, name: 'runtime', cpuPercent: 0, memoryMb: 4 },
        ]);

        expect(tree.map(({ pid }) => pid)).toEqual([1, 4]);
        expect(tree[0].children[0]).toMatchObject({ pid: 2 });
        expect(tree[0].children[0].children[0]).toMatchObject({ pid: 3 });
    });
});
