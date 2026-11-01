import { describe, expect, it } from 'vitest';

import { treeNavigationAction } from '../source-control-tree-navigation';

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
        expect(treeNavigationAction('ArrowRight', true, true)).toBe('firstChild');
        expect(treeNavigationAction('ArrowLeft', true, true)).toBe('collapse');
        expect(treeNavigationAction('ArrowRight', false, false)).toBeUndefined();
    });
});
