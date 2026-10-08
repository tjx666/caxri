import type { TreeItemDto } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    extensionTreeHorizontalIntent,
    isNavigableExtensionTreeRow,
    nextExtensionTreeRowIndex,
} from '../extension-tree-navigation';
import { flattenVisibleRows } from '../extension-tree-rows';

const ROOT = 'root';

function item(
    handle: string,
    collapsibleState: TreeItemDto['collapsibleState'] = 'none',
): TreeItemDto {
    return { handle, label: handle, accessibilityLabel: handle, collapsibleState };
}

/**
 * Rows are built through `flattenVisibleRows` rather than hand-written literals so the navigation math is tested
 * against the exact row shapes the view renders, including where a branch's placeholder actually lands.
 */
function rowsFor(
    children: ReadonlyMap<string, readonly TreeItemDto[]>,
    expanded: ReadonlySet<string>,
    options: { errors?: ReadonlyMap<string, string>; loading?: ReadonlySet<string> } = {},
) {
    return flattenVisibleRows({
        children,
        errors: options.errors ?? new Map(),
        isExpanded: ({ handle }) => expanded.has(handle),
        loading: options.loading ?? new Set(),
        rootHandle: ROOT,
    });
}

/**
 * `a` is expanded over a branch that has not resolved into items yet, so its placeholder row sits between two real
 * rows, the shape that used to stall Up and Down.
 */
function rowsAroundPlaceholder(kind: 'loading' | 'error' | 'empty') {
    const children = new Map<string, readonly TreeItemDto[]>([
        [ROOT, [item('a', 'expanded'), item('b')]],
    ]);
    if (kind === 'empty') children.set('a', []);
    return rowsFor(children, new Set(['a']), {
        errors: kind === 'error' ? new Map([['a', 'boom']]) : undefined,
        loading: kind === 'loading' ? new Set(['a']) : undefined,
    });
}

const expandedBranch = rowsFor(
    new Map([
        [ROOT, [item('a', 'expanded'), item('b')]],
        ['a', [item('a1')]],
    ]),
    new Set(['a']),
);

describe('isNavigableExtensionTreeRow', () => {
    it('accepts provider items and rejects every placeholder row', () => {
        expect(isNavigableExtensionTreeRow(expandedBranch[0])).toBe(true);
        for (const kind of ['loading', 'error', 'empty'] as const)
            expect(isNavigableExtensionTreeRow(rowsAroundPlaceholder(kind)[1])).toBe(false);
        expect(isNavigableExtensionTreeRow(undefined)).toBe(false);
    });
});

describe('nextExtensionTreeRowIndex', () => {
    it('moves Down and Up by one row', () => {
        expect(nextExtensionTreeRowIndex(expandedBranch, 0, 'ArrowDown')).toBe(1);
        expect(nextExtensionTreeRowIndex(expandedBranch, 1, 'ArrowUp')).toBe(0);
    });

    it('steps over a loading, error, or empty row instead of stalling on it', () => {
        for (const kind of ['loading', 'error', 'empty'] as const) {
            const rows = rowsAroundPlaceholder(kind);
            expect(rows[1]?.kind, kind).toBe(kind);
            expect(nextExtensionTreeRowIndex(rows, 0, 'ArrowDown'), kind).toBe(2);
            expect(nextExtensionTreeRowIndex(rows, 2, 'ArrowUp'), kind).toBe(0);
        }
    });

    it('stops at either edge instead of wrapping', () => {
        expect(nextExtensionTreeRowIndex(expandedBranch, 0, 'ArrowUp')).toBeUndefined();
        expect(nextExtensionTreeRowIndex(expandedBranch, 2, 'ArrowDown')).toBeUndefined();
    });

    it('scans inwards for Home and End so a placeholder never becomes the edge', () => {
        const rows = rowsFor(
            new Map([
                [ROOT, [item('a', 'expanded')]],
                ['a', []],
            ]),
            new Set(['a']),
        );
        expect(rows.at(-1)?.kind).toBe('empty');
        expect(nextExtensionTreeRowIndex(rows, 1, 'End')).toBe(0);
        expect(nextExtensionTreeRowIndex(rows, 1, 'Home')).toBe(0);
    });

    it('returns undefined when the view has no navigable row at all', () => {
        const rows = rowsFor(new Map(), new Set(), { loading: new Set([ROOT]) });
        expect(rows.map((row) => row.kind)).toEqual(['loading']);
        for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End'] as const)
            expect(nextExtensionTreeRowIndex(rows, 0, key), key).toBeUndefined();
    });
});

describe('extensionTreeHorizontalIntent', () => {
    it('expands a collapsed node on Right', () => {
        const rows = rowsFor(new Map([[ROOT, [item('a', 'collapsed'), item('b')]]]), new Set());
        expect(extensionTreeHorizontalIntent(rows, 0, 'ArrowRight')).toEqual({ toggle: true });
    });

    /**
     * The second Right press is what used to be a dead key: the branch was already open and the arrow that opened it
     * had nothing left to do, leaving Down as the only way in.
     */
    it('enters the first child of an already expanded node on Right', () => {
        expect(extensionTreeHorizontalIntent(expandedBranch, 0, 'ArrowRight')).toEqual({
            focusIndex: 1,
        });
    });

    it('refuses to enter a branch whose first row is a placeholder', () => {
        for (const kind of ['loading', 'error', 'empty'] as const)
            expect(
                extensionTreeHorizontalIntent(rowsAroundPlaceholder(kind), 0, 'ArrowRight'),
                kind,
            ).toEqual({});
    });

    it('does nothing on Right for a leaf row', () => {
        expect(extensionTreeHorizontalIntent(expandedBranch, 2, 'ArrowRight')).toEqual({});
    });

    it('collapses an expanded node on Left and climbs to the parent from a child', () => {
        expect(extensionTreeHorizontalIntent(expandedBranch, 0, 'ArrowLeft')).toEqual({
            toggle: true,
        });
        expect(extensionTreeHorizontalIntent(expandedBranch, 1, 'ArrowLeft')).toEqual({
            focusIndex: 0,
        });
    });

    it('does nothing on Left for a root row with nothing above it to climb to', () => {
        expect(extensionTreeHorizontalIntent(expandedBranch, 2, 'ArrowLeft')).toEqual({});
    });

    it('resolves to nothing for a placeholder row and for an index outside the list', () => {
        const rows = rowsAroundPlaceholder('loading');
        expect(extensionTreeHorizontalIntent(rows, 1, 'ArrowLeft')).toEqual({});
        expect(extensionTreeHorizontalIntent(rows, 1, 'ArrowRight')).toEqual({});
        expect(extensionTreeHorizontalIntent(rows, 99, 'ArrowRight')).toEqual({});
    });
});
