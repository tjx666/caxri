import { describe, expect, it } from 'vitest';

import {
    adjacentTreeItemIndex,
    parentTreeItemIndex,
    treeNavigationAction,
} from '../source-control-tree-navigation';

describe('adjacentTreeItemIndex', () => {
    it('returns the next index within bounds', () => {
        const items = [{ level: 1 }, { level: 1 }, { level: 1 }];

        expect(adjacentTreeItemIndex(items, 0, 1)).toBe(1);
        expect(adjacentTreeItemIndex(items, 1, -1)).toBe(0);
    });

    it('returns undefined past either edge instead of wrapping', () => {
        const items = [{ level: 1 }, { level: 1 }];

        expect(adjacentTreeItemIndex(items, 1, 1)).toBeUndefined();
        expect(adjacentTreeItemIndex(items, 0, -1)).toBeUndefined();
    });
});

describe('parentTreeItemIndex', () => {
    it('finds the nearest earlier item at a shallower level', () => {
        // root (level 1), child (level 2), grandchild (level 3)
        const items = [{ level: 1 }, { level: 2 }, { level: 3 }];

        expect(parentTreeItemIndex(items, 2)).toBe(1);
        expect(parentTreeItemIndex(items, 1)).toBe(0);
    });

    it('skips over a sibling subtree at the same or deeper level', () => {
        // dir-a (1), dir-a/child (2), dir-b (1) <- index 2, its parent is the tree root, not dir-a
        const items = [{ level: 1 }, { level: 2 }, { level: 1 }];

        expect(parentTreeItemIndex(items, 2)).toBeUndefined();
    });

    it('returns undefined for a top-level item with no ancestor', () => {
        const items = [{ level: 1 }, { level: 1 }];

        expect(parentTreeItemIndex(items, 0)).toBeUndefined();
    });

    it('returns undefined for an out-of-range index', () => {
        const items = [{ level: 1 }];

        expect(parentTreeItemIndex(items, 5)).toBeUndefined();
    });
});

describe('treeNavigationAction', () => {
    it('moves through visible rows and their parent without wrapping', () => {
        expect(treeNavigationAction('ArrowDown', false, false)).toBe('next');
        expect(treeNavigationAction('ArrowUp', false, false)).toBe('previous');
        expect(treeNavigationAction('Home', false, false)).toBe('first');
        expect(treeNavigationAction('End', false, false)).toBe('last');
        expect(treeNavigationAction('ArrowLeft', false, false)).toBe('parent');
    });

    it('expands, enters, and collapses a directory in sequence', () => {
        expect(treeNavigationAction('ArrowRight', true, false)).toBe('expand');
        expect(treeNavigationAction('ArrowRight', true, true)).toBe('child');
        expect(treeNavigationAction('ArrowLeft', true, true)).toBe('collapse');
        expect(treeNavigationAction('ArrowRight', false, false)).toBeUndefined();
    });
});
