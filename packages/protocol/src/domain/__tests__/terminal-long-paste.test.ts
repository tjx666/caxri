import { describe, expect, it } from 'vitest';

import { MAX_LONG_PASTE_BYTES, terminalLongPasteParametersSchema } from '../terminal-long-paste.js';

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
