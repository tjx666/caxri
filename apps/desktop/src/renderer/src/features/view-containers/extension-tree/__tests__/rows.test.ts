import type { TreeItemDto } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { flattenVisibleRows, loadingPlaceholderDepths, loadingPlaceholderRowCount } from '../rows';

const ROOT = 'root';

function item(
    handle: string,
    collapsibleState: TreeItemDto['collapsibleState'] = 'none',
): TreeItemDto {
    return { handle, label: handle, accessibilityLabel: handle, collapsibleState };
}

function flatten(
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
    expanded: ReadonlySet<string>,
    previous?: ReturnType<typeof flattenVisibleRows>,
    options: { errors?: ReadonlyMap<string, string>; loading?: ReadonlySet<string> } = {},
) {
    return flattenVisibleRows({
        children,
        errors: options.errors ?? new Map(),
        isExpanded: ({ handle }) => expanded.has(handle),
        loading: options.loading ?? new Set(),
        previous,
        rootHandle: ROOT,
    });
}

describe('flattenVisibleRows', () => {
    it('precomputes sibling position, set size, parent index, and expansion', () => {
        const children = new Map([
            [ROOT, [item('a', 'expanded'), item('b')]],
            ['a', [item('a1'), item('a2')]],
        ]);
        const rows = flatten(children, new Set(['a']));

        expect(rows.map((row) => (row.kind === 'item' ? row.item.handle : row.kind))).toEqual([
            'a',
            'a1',
            'a2',
            'b',
        ]);
        expect(rows[0]).toMatchObject({
            isExpanded: true,
            parentIndex: -1,
            positionInSet: 1,
            setSize: 2,
        });
        expect(rows[2]).toMatchObject({
            depth: 1,
            isExpanded: false,
            parentIndex: 0,
            positionInSet: 2,
            setSize: 2,
        });
        expect(rows[3]).toMatchObject({ parentIndex: -1, positionInSet: 2, setSize: 2 });
    });

    it('does not announce an expanded branch whose children were never requested', () => {
        const rows = flatten(new Map([[ROOT, [item('a', 'collapsed')]]]), new Set(['a']));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ isExpanded: false });
    });

    it('renders loading, error, and empty placeholder rows under their parent', () => {
        const children = new Map([
            [ROOT, [item('a', 'expanded'), item('b', 'expanded'), item('c', 'expanded')]],
            ['c', []],
        ]);
        const rows = flatten(children, new Set(['a', 'b', 'c']), undefined, {
            errors: new Map([['b', 'boom']]),
            loading: new Set(['a']),
        });
        expect(rows.map((row) => row.kind)).toEqual([
            'item',
            'loading',
            'item',
            'error',
            'item',
            'empty',
        ]);
        expect(rows[3]).toMatchObject({ depth: 1, parentHandle: 'b', message: 'boom' });
    });

    it('reuses previous row objects when a refresh yields equal items', () => {
        const before = flatten(new Map([[ROOT, [item('a'), item('b')]]]), new Set());
        const after = flatten(
            new Map([[ROOT, [item('a'), { ...item('b'), label: 'renamed' }]]]),
            new Set(),
            before,
        );
        expect(after[0]).toBe(before[0]);
        expect(after[1]).not.toBe(before[1]);
        expect(after[1]).toMatchObject({ item: { label: 'renamed' } });
    });

    it('drops a reused row when its position or expansion changes', () => {
        const children = new Map([
            [ROOT, [item('a', 'collapsed'), item('b')]],
            ['a', [item('a1')]],
        ]);
        const before = flatten(children, new Set());
        const after = flatten(children, new Set(['a']), before);
        expect(after[0]).not.toBe(before[0]);
        expect(after[2]).toBe(before[1]);
    });
});

describe('loadingPlaceholderRowCount', () => {
    it('draws the first load as a parent over its children and a nested branch as one row', () => {
        const rows = flatten(
            new Map([[ROOT, [item('folder', 'expanded')]]]),
            new Set(['folder']),
            undefined,
            { loading: new Set(['folder']) },
        );
        const nested = rows.find((row) => row.kind === 'loading');
        expect(nested && loadingPlaceholderRowCount(nested)).toBe(1);
        const [root] = flatten(new Map(), new Set(), undefined, { loading: new Set([ROOT]) });
        expect(root.kind === 'loading' && loadingPlaceholderDepths(root)).toEqual([0, 1, 1]);
        expect(root.kind === 'loading' && loadingPlaceholderRowCount(root)).toBe(3);
        expect(loadingPlaceholderRowCount({ kind: 'empty', depth: 0, parentHandle: ROOT })).toBe(1);
    });
});
