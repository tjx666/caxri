import { describe, expect, it } from 'vitest';

import { editorNavigationTargetSchema } from '../editor';

describe('editorNavigationTargetSchema', () => {
    it('accepts explicit caret and whole-line range intents', () => {
        expect(
            editorNavigationTargetSchema.safeParse({ mode: 'caret', line: 12, column: 4 }).success,
        ).toBe(true);
        expect(
            editorNavigationTargetSchema.safeParse({
                mode: 'line',
                startLine: 20,
                endLine: 21,
            }).success,
        ).toBe(true);
    });

    it.each([
        { mode: 'caret', line: 0, column: 1 },
        { mode: 'caret', line: 1, column: 0 },
        { mode: 'line', startLine: 0, endLine: 1 },
        { mode: 'line', startLine: 21, endLine: 20 },
    ])('rejects invalid navigation target $mode', (target) => {
        expect(editorNavigationTargetSchema.safeParse(target).success).toBe(false);
    });
});
