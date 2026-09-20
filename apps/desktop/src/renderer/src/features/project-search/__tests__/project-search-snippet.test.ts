import { describe, expect, it } from 'vitest';

import { searchSnippetLines } from '../project-search-snippet';

const content = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`).join('\n');

describe('searchSnippetLines', () => {
    it('centers the window on the matching line and marks only it', () => {
        const snippet = searchSnippetLines(content, 20, 2);

        expect(snippet.map((line) => line.number)).toEqual([18, 19, 20, 21, 22]);
        expect(snippet.filter((line) => line.isMatch).map((line) => line.number)).toEqual([20]);
        expect(snippet[0]?.text).toBe('line 18');
    });

    it('shows the head of the file for a name result, which has no matching line', () => {
        const snippet = searchSnippetLines(content, undefined, 2);

        expect(snippet.map((line) => line.number)).toEqual([1, 2, 3, 4, 5]);
        expect(snippet.some((line) => line.isMatch)).toBe(false);
    });

    it('keeps the window the same height at the start of the file', () => {
        expect(searchSnippetLines(content, 1, 2).map((line) => line.number)).toEqual([
            1, 2, 3, 4, 5,
        ]);
    });

    it('keeps the window the same height at the end of the file', () => {
        expect(searchSnippetLines(content, 40, 2).map((line) => line.number)).toEqual([
            36, 37, 38, 39, 40,
        ]);
    });

    it('returns the whole file when it is shorter than the window', () => {
        const snippet = searchSnippetLines('a\nb', 2, 4);

        expect(snippet.map((line) => line.number)).toEqual([1, 2]);
        expect(snippet[1]?.isMatch).toBe(true);
    });

    it('clips a line long enough to push every other line out of view', () => {
        const snippet = searchSnippetLines('x'.repeat(5000), 1, 1);

        expect(snippet[0]?.text).toHaveLength(401);
        expect(snippet[0]?.text.endsWith('…')).toBe(true);
    });
});
