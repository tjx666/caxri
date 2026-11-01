import { describe, expect, it } from 'vitest';

import type { TreeNavigation } from './tree-navigation';
import { treeNavigationTarget } from './tree-navigation';

interface Row {
    depth: number;
    kind: 'entry' | 'create' | 'empty' | 'truncated';
    name: string;
}

const model = {
    depthOf: (row: Row) => row.depth,
    isFocusable: (row: Row) => row.kind === 'entry',
};

/**
 * A Files-like tree, by index:
 *
 * - 0 `src/`, expanded
 * - 1 inline create field in `src/`
 * - 2 `src/a.ts`
 * - 3 `src/empty/`, expanded with no entries
 * - 4 empty notice in `src/empty/`
 * - 5 `src/b.ts`
 * - 6 truncated notice in `src/`
 * - 7 `README.md`
 */
const rows: Row[] = [
    { depth: 0, kind: 'entry', name: 'src' },
    { depth: 1, kind: 'create', name: 'create' },
    { depth: 1, kind: 'entry', name: 'a.ts' },
    { depth: 1, kind: 'entry', name: 'empty' },
    { depth: 2, kind: 'empty', name: 'empty-notice' },
    { depth: 1, kind: 'entry', name: 'b.ts' },
    { depth: 1, kind: 'truncated', name: 'truncated' },
    { depth: 0, kind: 'entry', name: 'README.md' },
];

const target = (from: number, action: TreeNavigation) =>
    treeNavigationTarget(rows, from, action, model);

describe('treeNavigationTarget', () => {
    it('steps over the create field, empty notices, and truncated rows', () => {
        expect(target(0, 'next')).toBe(2);
        expect(target(3, 'next')).toBe(5);
        expect(target(5, 'next')).toBe(7);
        expect(target(7, 'previous')).toBe(5);
        expect(target(2, 'previous')).toBe(0);
    });

    it('stops at either edge instead of wrapping', () => {
        expect(target(0, 'previous')).toBeUndefined();
        expect(target(7, 'next')).toBeUndefined();
    });

    it('lands Home and End on the first and last focusable rows', () => {
        const withNoticesAtEdges: Row[] = [
            { depth: 0, kind: 'create', name: 'create' },
            ...rows,
            { depth: 0, kind: 'truncated', name: 'truncated' },
        ];
        expect(treeNavigationTarget(withNoticesAtEdges, 4, 'first', model)).toBe(1);
        expect(treeNavigationTarget(withNoticesAtEdges, 4, 'last', model)).toBe(8);
        expect(treeNavigationTarget([], 0, 'first', model)).toBeUndefined();
    });

    it('enters the first focusable child, past an open create field', () => {
        expect(target(0, 'firstChild')).toBe(2);
    });

    it('keeps focus on an expanded folder with no entries instead of reaching its sibling', () => {
        expect(target(3, 'firstChild')).toBeUndefined();
    });

    it('has no first child for a leaf or a row that cannot take focus', () => {
        expect(target(2, 'firstChild')).toBeUndefined();
        expect(target(7, 'firstChild')).toBeUndefined();
        expect(target(1, 'firstChild')).toBeUndefined();
    });

    it('climbs to the enclosing row, from entries and notices alike', () => {
        expect(target(5, 'parent')).toBe(0);
        expect(target(4, 'parent')).toBe(3);
        expect(target(6, 'parent')).toBe(0);
        expect(target(7, 'parent')).toBeUndefined();
    });

    it('treats every row as focusable when the model does not say otherwise', () => {
        const plain = [{ depth: 0 }, { depth: 1 }, { depth: 0 }];
        const depthOf = (row: { depth: number }) => row.depth;
        expect(treeNavigationTarget(plain, 0, 'next', { depthOf })).toBe(1);
        expect(treeNavigationTarget(plain, 0, 'firstChild', { depthOf })).toBe(1);
        expect(treeNavigationTarget(plain, 1, 'parent', { depthOf })).toBe(0);
    });

    it('answers nothing for an index outside the rows', () => {
        expect(target(-1, 'next')).toBeUndefined();
        expect(target(8, 'previous')).toBeUndefined();
        expect(target(8, 'parent')).toBeUndefined();
    });
});
