import type { FileSearchMatch } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    nextSelectionIndex,
    searchMatchKey,
    selectableSearchMatches,
} from '../project-search-selection';
import { buildNameSearchTree, groupSearchMatches } from '../project-search-tree';

function match(relativePath: string, line?: number, column?: number): FileSearchMatch {
    return {
        path: `/project/${relativePath}`,
        relativePath,
        ...(line !== undefined && { line }),
        ...(column !== undefined && { column }),
    };
}

describe('searchMatchKey', () => {
    it('separates two hits in one file, which share a path', () => {
        expect(searchMatchKey(match('src/a.ts', 3, 1))).not.toBe(
            searchMatchKey(match('src/a.ts', 9, 1)),
        );
    });

    it('is stable across refetches of the same result', () => {
        expect(searchMatchKey(match('src/a.ts', 3, 1))).toBe(
            searchMatchKey(match('src/a.ts', 3, 1)),
        );
    });

    it('gives a name result without a line a key of its own', () => {
        expect(searchMatchKey(match('src/a.ts'))).toBe('src/a.ts:0:0');
    });
});

describe('selectableSearchMatches', () => {
    it('follows the painted order of the name tree, which sorts directories first', () => {
        const matches = [match('readme.md'), match('src/b.ts'), match('src/a.ts')];

        expect(
            selectableSearchMatches('name', new Map(), buildNameSearchTree(matches)).map(
                (item) => item.relativePath,
            ),
        ).toEqual(['src/a.ts', 'src/b.ts', 'readme.md']);
    });

    it('keeps content hits grouped by file, and skips the group headings', () => {
        const matches = [match('src/a.ts', 3, 1), match('src/b.ts', 7, 1), match('src/a.ts', 9, 1)];

        expect(
            selectableSearchMatches('content', groupSearchMatches(matches), []).map(searchMatchKey),
        ).toEqual(['src/a.ts:3:1', 'src/a.ts:9:1', 'src/b.ts:7:1']);
    });

    it('has nothing to select before a search has run', () => {
        expect(selectableSearchMatches('content', new Map(), [])).toEqual([]);
    });
});

describe('nextSelectionIndex', () => {
    it('steps through the list', () => {
        expect(nextSelectionIndex(5, 2, 1)).toBe(3);
        expect(nextSelectionIndex(5, 2, -1)).toBe(1);
    });

    it('holds at both ends rather than wrapping, so a held key never teleports', () => {
        expect(nextSelectionIndex(5, 4, 1)).toBe(4);
        expect(nextSelectionIndex(5, 0, -1)).toBe(0);
    });

    it('stays at the first row when there is nothing to select', () => {
        expect(nextSelectionIndex(0, 0, 1)).toBe(0);
    });
});
