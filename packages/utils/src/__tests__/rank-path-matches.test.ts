import { describe, expect, it } from 'vitest';

import { rankPathMatches } from '../rank-path-matches';

const rank = (paths: string[], query: string, limit = 10) =>
    rankPathMatches(paths, (path) => path, query, limit);

describe('rankPathMatches', () => {
    it('ranks a file-name hit above one that only matched a directory segment', () => {
        expect(rank(['search/deep/notes.ts', 'a/search.ts'], 'search')).toEqual([
            'a/search.ts',
            'search/deep/notes.ts',
        ]);
    });

    it('orders an exact name, then a bare stem, then a prefix, then a loose contains', () => {
        expect(
            rank(['d/my-token-helper.ts', 'c/token', 'b/tokenizer.ts', 'a/token.ts'], 'token'),
        ).toEqual(['c/token', 'a/token.ts', 'b/tokenizer.ts', 'd/my-token-helper.ts']);
    });

    it('breaks ties toward the shallower path so the nearest copy leads', () => {
        expect(rank(['a/b/c/index.ts', 'a/index.ts'], 'index')).toEqual([
            'a/index.ts',
            'a/b/c/index.ts',
        ]);
    });

    it('is stable for equal ranks, matches case-insensitively, and caps the result', () => {
        expect(rank(['b/Index.ts', 'a/index.ts'], 'INDEX')).toEqual(['a/index.ts', 'b/Index.ts']);
        expect(rank(['a/x.ts', 'b/x.ts', 'c/x.ts'], 'x', 2)).toHaveLength(2);
    });

    it('keeps the caller items, not just their paths', () => {
        const items = [
            { id: 1, path: 'z/a.ts' },
            { id: 2, path: 'a.ts' },
        ];
        expect(rankPathMatches(items, (item) => item.path, 'a', 5).map((item) => item.id)).toEqual([
            2, 1,
        ]);
    });
});
