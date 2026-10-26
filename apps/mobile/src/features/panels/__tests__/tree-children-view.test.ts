import { describe, expect, it } from 'vitest';

import { treeChildrenView } from '../tree-children-view';

const base = { isError: false, isPending: false, itemCount: 2 };

describe('treeChildrenView', () => {
    it('shows feedback for nested pending and empty levels', () => {
        expect(treeChildrenView({ ...base, depth: 1, isPending: true })).toBe('nested-loading');
        expect(treeChildrenView({ ...base, depth: 2, itemCount: 0 })).toBe('nested-empty');
    });
    it('keeps block status at the root', () => {
        expect(treeChildrenView({ ...base, depth: 0, isPending: true })).toBe('root-loading');
        expect(treeChildrenView({ ...base, depth: 0, itemCount: 0 })).toBe('root-empty');
    });
    it('reports errors and rows at any depth', () => {
        expect(treeChildrenView({ ...base, depth: 1, isError: true })).toBe('error');
        expect(treeChildrenView({ ...base, depth: 1 })).toBe('rows');
    });
});
