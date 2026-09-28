import { describe, expect, it } from 'vitest';

import { virtualTreeRenderedIndexes } from '../virtual-tree-range';

describe('virtualTreeRenderedIndexes', () => {
    it('keeps a retained row mounted in tree order after the window scrolled away from it', () => {
        expect(virtualTreeRenderedIndexes([380, 381, 382], 400, [3])).toEqual([3, 380, 381, 382]);
    });

    it('adds nothing for a retained row already inside the window', () => {
        expect(virtualTreeRenderedIndexes([0, 1, 2], 3, [1])).toEqual([0, 1, 2]);
    });

    it('ignores a missing or stale retained index', () => {
        expect(virtualTreeRenderedIndexes([0, 1], 2, [-1, 2, 7])).toEqual([0, 1]);
        expect(virtualTreeRenderedIndexes([], 0, [0])).toEqual([]);
    });
});
