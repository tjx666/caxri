import { describe, expect, it } from 'vitest';

import { formatLineCount, visibleDiffStatParts } from '../line-count-format';

describe('formatLineCount', () => {
    it.each([
        [0, '0'],
        [684, '684'],
        [999, '999'],
        [1000, '1k'],
        [1234, '1.2k'],
        [1950, '2k'],
        [12_345, '12.3k'],
        [99_960, '100k'],
        [123_456, '123k'],
        [999_600, '1m'],
        [1_234_567, '1.2m'],
        [2_500_000_000, '2.5b'],
    ])('formats %i as %s', (count, expected) => {
        expect(formatLineCount(count)).toBe(expected);
    });
});

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
