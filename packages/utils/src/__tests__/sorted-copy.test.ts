import { describe, expect, it } from 'vitest';

import { sortedCopy } from '../sorted-copy.js';

describe('sortedCopy', () => {
    it('sorts any iterable without mutating array inputs', () => {
        const input = [3, 1, 2];

        expect(sortedCopy(input, (left, right) => left - right)).toEqual([1, 2, 3]);
        expect(input).toEqual([3, 1, 2]);
        expect(sortedCopy(new Set(input), (left, right) => right - left)).toEqual([3, 2, 1]);
    });
});
