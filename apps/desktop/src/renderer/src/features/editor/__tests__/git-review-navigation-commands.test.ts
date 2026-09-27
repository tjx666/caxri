import { describe, expect, it } from 'vitest';

import type { ReviewCommentAnchor } from '../git-review-navigation-commands';
import {
    compareReviewCommentAnchors,
    nextReviewCommentIndex,
} from '../git-review-navigation-commands';

function anchor(overrides: Partial<ReviewCommentAnchor> = {}): ReviewCommentAnchor {
    return { id: 'a', path: 'src/example.ts', startLine: 1, side: 'modified', ...overrides };
}

describe('compareReviewCommentAnchors', () => {
    it('orders by file path first', () => {
        const a = anchor({ id: 'a', path: 'a.ts' });
        const b = anchor({ id: 'b', path: 'b.ts' });
        expect(compareReviewCommentAnchors(a, b)).toBeLessThan(0);
        expect(compareReviewCommentAnchors(b, a)).toBeGreaterThan(0);
    });

    it('orders by start line within the same file', () => {
        const a = anchor({ id: 'a', startLine: 2 });
        const b = anchor({ id: 'b', startLine: 5 });
        expect(compareReviewCommentAnchors(a, b)).toBeLessThan(0);
        expect(compareReviewCommentAnchors(b, a)).toBeGreaterThan(0);
    });

    it('orders the original side before the modified side at the same line', () => {
        const original = anchor({ id: 'a', side: 'original' });
        const modified = anchor({ id: 'b', side: 'modified' });
        expect(compareReviewCommentAnchors(original, modified)).toBeLessThan(0);
        expect(compareReviewCommentAnchors(modified, original)).toBeGreaterThan(0);
    });

    it('falls back to id to keep the order stable and total', () => {
        const a = anchor({ id: 'a' });
        const b = anchor({ id: 'b' });
        expect(compareReviewCommentAnchors(a, b)).toBeLessThan(0);
        expect(compareReviewCommentAnchors(a, a)).toBe(0);
    });
});

describe('nextReviewCommentIndex', () => {
    const order: ReviewCommentAnchor[] = [
        anchor({ id: 'a', startLine: 1 }),
        anchor({ id: 'b', startLine: 2 }),
        anchor({ id: 'c', startLine: 3 }),
    ];

    it('returns -1 for an empty order', () => {
        expect(nextReviewCommentIndex([], undefined, 1)).toBe(-1);
        expect(nextReviewCommentIndex([], 'a', -1)).toBe(-1);
    });

    it('starts at the first anchor going forward when nothing is current', () => {
        expect(nextReviewCommentIndex(order, undefined, 1)).toBe(0);
    });

    it('starts at the last anchor going backward when nothing is current', () => {
        expect(nextReviewCommentIndex(order, undefined, -1)).toBe(2);
    });

    it('starts at the first anchor going forward when the remembered anchor no longer exists', () => {
        expect(nextReviewCommentIndex(order, 'stale-id', 1)).toBe(0);
    });

    it('starts at the last anchor going backward when the remembered anchor no longer exists', () => {
        expect(nextReviewCommentIndex(order, 'stale-id', -1)).toBe(2);
    });

    it('advances to the next anchor and wraps around at the end', () => {
        expect(nextReviewCommentIndex(order, 'a', 1)).toBe(1);
        expect(nextReviewCommentIndex(order, 'b', 1)).toBe(2);
        expect(nextReviewCommentIndex(order, 'c', 1)).toBe(0);
    });

    it('moves to the previous anchor and wraps around at the start', () => {
        expect(nextReviewCommentIndex(order, 'c', -1)).toBe(1);
        expect(nextReviewCommentIndex(order, 'b', -1)).toBe(0);
        expect(nextReviewCommentIndex(order, 'a', -1)).toBe(2);
    });
});
