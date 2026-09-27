import type { SourceControlResource } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { buildSourceControlResourceTree } from '../source-control-tree';
import {
    flattenSourceControlTree,
    sourceControlRenderedIndexes,
    sourceControlTreeNavigationTarget,
} from '../source-control-tree-rows';

function resource(path: string): SourceControlResource {
    return {
        id: path,
        label: path.split('/').at(-1)!,
        tooltip: path,
        accessibilityLabel: path,
        icon: { kind: 'file-type', name: path.split('/').at(-1)! },
        path,
    };
}

const PROVIDER_KEY = 'working-tree:repo';

const nodes = buildSourceControlResourceTree([
    resource('src/a.ts'),
    resource('src/nested/b.ts'),
    resource('README.md'),
]);

describe('flattenSourceControlTree', () => {
    it('lists expanded folders depth-first with parent links and sibling positions', () => {
        const rows = flattenSourceControlTree(nodes, PROVIDER_KEY, {});
        expect(
            rows.map(({ depth, parentIndex, positionInSet, rowId, setSize }) => ({
                depth,
                parentIndex,
                positionInSet,
                rowId,
                setSize,
            })),
        ).toEqual([
            {
                depth: 0,
                parentIndex: -1,
                positionInSet: 1,
                rowId: `directory:${PROVIDER_KEY}:src`,
                setSize: 2,
            },
            {
                depth: 1,
                parentIndex: 0,
                positionInSet: 1,
                rowId: `directory:${PROVIDER_KEY}:src/nested`,
                setSize: 2,
            },
            {
                depth: 2,
                parentIndex: 1,
                positionInSet: 1,
                rowId: 'resource:src/nested/b.ts',
                setSize: 1,
            },
            { depth: 1, parentIndex: 0, positionInSet: 2, rowId: 'resource:src/a.ts', setSize: 2 },
            {
                depth: 0,
                parentIndex: -1,
                positionInSet: 2,
                rowId: 'resource:README.md',
                setSize: 2,
            },
        ]);
    });

    it('omits the children of a collapsed folder', () => {
        const rows = flattenSourceControlTree(nodes, PROVIDER_KEY, {
            [`${PROVIDER_KEY}:src`]: false,
        });
        expect(rows.map((row) => row.rowId)).toEqual([
            `directory:${PROVIDER_KEY}:src`,
            'resource:README.md',
        ]);
        expect(rows[0]).toMatchObject({
            expansionKey: `${PROVIDER_KEY}:src`,
            isExpanded: false,
        });
    });
});

describe('sourceControlTreeNavigationTarget', () => {
    const rows = flattenSourceControlTree(nodes, PROVIDER_KEY, {});

    it('moves between rows inside the resource tree', () => {
        expect(sourceControlTreeNavigationTarget(rows, 1, 'next')).toBe(2);
        expect(sourceControlTreeNavigationTarget(rows, 3, 'previous')).toBe(2);
        expect(sourceControlTreeNavigationTarget(rows, 3, 'parent')).toBe(0);
        expect(sourceControlTreeNavigationTarget(rows, 2, 'parent')).toBe(1);
        expect(sourceControlTreeNavigationTarget(rows, 0, 'child')).toBe(1);
    });

    it('hands edge moves and disclosure changes to the surrounding tree', () => {
        expect(sourceControlTreeNavigationTarget(rows, 0, 'previous')).toBeUndefined();
        expect(sourceControlTreeNavigationTarget(rows, 4, 'next')).toBeUndefined();
        expect(sourceControlTreeNavigationTarget(rows, 0, 'parent')).toBeUndefined();
        expect(sourceControlTreeNavigationTarget(rows, 2, 'child')).toBeUndefined();
        expect(sourceControlTreeNavigationTarget(rows, 0, 'expand')).toBeUndefined();
        expect(sourceControlTreeNavigationTarget(rows, 0, 'last')).toBeUndefined();
    });
});

describe('sourceControlRenderedIndexes', () => {
    it('keeps the edge rows and the Tab stop row mounted, in tree order', () => {
        expect(sourceControlRenderedIndexes([40, 41, 42], 1000, [7])).toEqual([
            0, 7, 40, 41, 42, 999,
        ]);
    });

    it('ignores an absent Tab stop and an empty list', () => {
        expect(sourceControlRenderedIndexes([0, 1], 2, [-1])).toEqual([0, 1]);
        expect(sourceControlRenderedIndexes([], 0, [0])).toEqual([]);
    });
});
