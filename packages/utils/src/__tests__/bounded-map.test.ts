import { describe, expect, it } from 'vitest';

import { rememberBounded } from '../bounded-map';

describe('rememberBounded', () => {
    it('evicts the least recently remembered entry once the map is full', () => {
        const entries = new Map<string, number>();
        rememberBounded(entries, 'a', 1, 2);
        rememberBounded(entries, 'b', 2, 2);
        rememberBounded(entries, 'c', 3, 2);
        expect(entries.keys().toArray()).toEqual(['b', 'c']);
    });

    it('moves an existing key back to the most-recently-used end', () => {
        const entries = new Map<string, number>();
        rememberBounded(entries, 'a', 1, 2);
        rememberBounded(entries, 'b', 2, 2);
        // Re-remembering `a` must protect it: without the delete-before-set, insertion order would still evict it first.
        rememberBounded(entries, 'a', 1, 2);
        rememberBounded(entries, 'c', 3, 2);
        expect(entries.keys().toArray()).toEqual(['a', 'c']);
    });

    it('keeps one entry when the caller asks for a non-positive maximum', () => {
        const entries = new Map<string, number>();
        rememberBounded(entries, 'a', 1, 0);
        rememberBounded(entries, 'b', 2, 0);
        expect([...entries]).toEqual([['b', 2]]);
    });

    it('drops the oldest entries when the map already exceeds the maximum', () => {
        const entries = new Map([
            ['a', 1],
            ['b', 2],
            ['c', 3],
        ]);
        rememberBounded(entries, 'd', 4, 2);
        expect(entries.keys().toArray()).toEqual(['c', 'd']);
    });
});
