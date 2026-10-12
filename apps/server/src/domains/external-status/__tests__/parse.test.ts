import { describe, expect, it } from 'vitest';

import { LINEAR_ISSUE_QUERY, linearDescriptionExcerpt, linearStateColor } from '../parse';

describe('Linear workflow state color', () => {
    it.each(['#5E6AD2', '#5e6ad2', '#5E6AD2FF'])('keeps the workspace color %s', (color) => {
        expect(linearStateColor(color)).toBe(color);
    });

    /**
     * The color travels from Linear straight to a `style` attribute on the icon, so anything that is not a hex literal
     * is dropped rather than forwarded. The issue still renders: it just inherits the row's theme color.
     */
    it.each([undefined, '', 'purple', 'rgb(94,106,210)', '#5E6AD', 'url(evil)'])(
        'drops %s, which Caxri cannot render as a color',
        (color) => {
            expect(linearStateColor(color)).toBeUndefined();
        },
    );

    it('asks Linear for the state color alongside its name and type', () => {
        expect(LINEAR_ISSUE_QUERY).toContain('state{name type color}');
    });
});

describe('Linear description excerpt', () => {
    it('turns escaped Markdown into one line of prose', () => {
        expect(
            linearDescriptionExcerpt(
                '\\## Problem\n\nRunning \\`round new\\` leaves **untracked** files; see [the guide](https://example.com/guide).\n\n- one\n- two',
            ),
        ).toBe('Problem Running round new leaves untracked files; see the guide. one two');
    });

    it('drops single emphasis and code fence markers but keeps identifiers intact', () => {
        expect(
            linearDescriptionExcerpt(
                'An *italic* and _underlined_ word\n```ts\nconst snake_case_name = 1\n```',
            ),
        ).toBe('An italic and underlined word const snake_case_name = 1');
    });

    it('stays fast on a long run of unmatched brackets', () => {
        const startedAt = performance.now();
        linearDescriptionExcerpt('['.repeat(50_000));
        expect(performance.now() - startedAt).toBeLessThan(200);
    });

    it('drops images and caps a long description', () => {
        expect(linearDescriptionExcerpt('![shot](https://example.com/a.png)')).toBeUndefined();
        const excerpt = linearDescriptionExcerpt('word '.repeat(200));
        expect(excerpt?.length).toBeLessThanOrEqual(281);
        expect(excerpt?.endsWith('…')).toBe(true);
    });

    it('has nothing to show for an empty description', () => {
        expect(linearDescriptionExcerpt(null)).toBeUndefined();
        expect(linearDescriptionExcerpt(' '.repeat(3))).toBeUndefined();
    });
});
