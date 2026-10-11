import { describe, expect, it } from 'vitest';

import {
    formatLongPasteReference,
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
