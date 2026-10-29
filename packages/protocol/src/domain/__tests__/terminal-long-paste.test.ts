import { describe, expect, it } from 'vitest';

import {
    formatLongPasteReference,
    longPasteReferenceRanges,
    MAX_LONG_PASTE_BYTES,
    terminalLongPasteParametersSchema,
} from '../terminal-long-paste.js';

describe('long paste limits', () => {
    it.each([
        ['x', 1],
        ['界', 3],
        ['🙂', 4],
    ] as const)('enforces the UTF-8 boundary for %s', (character, bytes) => {
        const content =
            character.repeat(Math.floor(MAX_LONG_PASTE_BYTES / bytes)) +
            'x'.repeat(MAX_LONG_PASTE_BYTES % bytes);
        expect(
            terminalLongPasteParametersSchema.safeParse({ terminalId: 'terminal-1', content })
                .success,
        ).toBe(true);
        expect(
            terminalLongPasteParametersSchema.safeParse({
                terminalId: 'terminal-1',
                content: `${content}x`,
            }).success,
        ).toBe(false);
    });
    it('accepts text larger than the former character ceiling', () => {
        const result = terminalLongPasteParametersSchema.safeParse({
            terminalId: 'terminal-1',
            content: 'x'.repeat(5 * 1024 * 1024),
        });
        expect(result.success).toBe(true);
    });
});

describe('long paste reference', () => {
    it('states the original size in singular units and names the subagent route', () => {
        expect(
            formatLongPasteReference({
                characterCount: 2_048,
                filePath: '/local/paste.txt',
                lineCount: 1,
            }),
        ).toBe(
            [
                '[Long paste saved locally]',
                'Original file: "/local/paste.txt"',
                'Original size: 1 line, 2048 characters',
                '',
                'Read the original file for the exact content.',
                'If a summary is enough, delegate it to a subagent on a small, fast model so the full text stays out of this conversation.',
            ].join('\n'),
        );
    });
});

describe('longPasteReferenceRanges', () => {
    const reference = (lineCount: number, filePath = '/local/paste.txt') =>
        formatLongPasteReference({ characterCount: 2_048, filePath, lineCount });

    it('finds each saved paste in a message without changing its text', () => {
        const first = reference(200);
        const second = reference(1, '/local/with space/paste 2.txt');
        const text = `look at ${first} and\n${second}\nthanks`;
        expect(longPasteReferenceRanges(text)).toEqual([
            {
                characterCount: 2_048,
                from: 8,
                lineCount: 200,
                path: '/local/paste.txt',
                to: 8 + first.length,
            },
            {
                characterCount: 2_048,
                from: text.indexOf(second),
                lineCount: 1,
                path: '/local/with space/paste 2.txt',
                to: text.indexOf(second) + second.length,
            },
        ]);
    });

    it('leaves an edited or relative-path note as text', () => {
        expect(longPasteReferenceRanges(reference(3).replace('saved locally', 'saved'))).toEqual(
            [],
        );
        expect(longPasteReferenceRanges(reference(3, 'relative.txt'))).toEqual([]);
        expect(longPasteReferenceRanges('[Long paste saved locally] typed by hand')).toEqual([]);
    });
});
