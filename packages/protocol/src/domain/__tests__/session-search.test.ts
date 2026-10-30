import { describe, expect, it } from 'vitest';

import { snippetSegments } from '../session-search';

describe('snippetSegments', () => {
    it('splits a snippet at its highlights and clamps bad ranges', () => {
        expect(snippetSegments({ text: 'fix the invoice total', highlights: [[8, 15]] })).toEqual([
            { text: 'fix the ', isMatch: false },
            { text: 'invoice', isMatch: true },
            { text: ' total', isMatch: false },
        ]);
        expect(
            snippetSegments({
                text: 'abc',
                highlights: [
                    [1, 9],
                    [0, 2],
                ],
            }),
        ).toEqual([
            { text: 'a', isMatch: false },
            { text: 'bc', isMatch: true },
        ]);
    });
});
