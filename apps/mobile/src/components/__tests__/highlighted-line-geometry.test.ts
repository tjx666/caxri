import { describe, expect, it } from 'vitest';

import {
    clipLineTokens,
    lineColumns,
    PREVIEW_LINE_MAX_CHARS,
    widestLineColumns,
} from '../highlighted-line-geometry';

describe('highlighted line geometry', () => {
    it('counts full-width characters as two columns', () => {
        expect(lineColumns('const a = 1;')).toBe(12);
        expect(lineColumns('// 中文注释')).toBe(3 + 8);
    });

    it('keeps short lines whole and cuts a minified line at the cap', () => {
        const short = [{ content: 'const' }, { content: ' a' }];
        expect(clipLineTokens(short).map(({ content }) => content)).toEqual(['const', ' a']);

        const minified = [
            { content: 'x'.repeat(PREVIEW_LINE_MAX_CHARS - 1), types: ['plain'] },
            { content: 'yyyy', types: ['keyword'] },
            { content: 'zzzz', types: ['plain'] },
        ];
        const clipped = clipLineTokens(minified);
        expect(clipped).toHaveLength(2);
        expect(clipped[1]).toEqual({ content: 'y…', types: ['keyword'] });
        expect(clipped.map(({ content }) => content).join('')).toHaveLength(
            PREVIEW_LINE_MAX_CHARS + 1,
        );
    });

    it('sizes the rows by the widest line, capped like the clipped rows', () => {
        expect(widestLineColumns('a\nabc\n中文')).toBe(4);
        expect(widestLineColumns('x'.repeat(500_000))).toBe(PREVIEW_LINE_MAX_CHARS + 1);
    });
});
