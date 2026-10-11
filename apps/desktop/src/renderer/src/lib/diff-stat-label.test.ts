import { describe, expect, it } from 'vitest';

import { diffStatLabel, visibleDiffStatParts } from './diff-stat-label';

describe('visibleDiffStatParts', () => {
    it('drops a zero half beside a non-zero one', () => {
        expect(visibleDiffStatParts({ additions: 3, deletions: 0 })).toEqual({
            additions: true,
            deletions: false,
        });
        expect(visibleDiffStatParts({ additions: 0, deletions: 2 })).toEqual({
            additions: false,
            deletions: true,
        });
    });

    it('keeps both halves when both changed, and `+0` alone when neither did', () => {
        expect(visibleDiffStatParts({ additions: 1, deletions: 1 })).toEqual({
            additions: true,
            deletions: true,
        });
        expect(visibleDiffStatParts({ additions: 0, deletions: 0 })).toEqual({
            additions: true,
            deletions: false,
        });
    });
});

describe('diffStatLabel', () => {
    it('keeps the exact counts in words', () => {
        expect(diffStatLabel({ additions: 1, deletions: 0 })).toBe('1 line added, 0 removed');
    });
});
