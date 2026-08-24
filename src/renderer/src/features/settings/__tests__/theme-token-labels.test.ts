import { describe, expect, it } from 'vitest';

import { humanizeThemeTokenLabel } from '../theme-token-labels';

describe('humanizeThemeTokenLabel', () => {
    it('uses the curated map for known theme token keys', () => {
        expect(humanizeThemeTokenLabel('selectionBackground')).toBe('Selection background');
        expect(humanizeThemeTokenLabel('brightMagenta')).toBe('Bright magenta');
        expect(humanizeThemeTokenLabel('lineHighlight')).toBe('Line highlight');
        expect(humanizeThemeTokenLabel('background')).toBe('Background');
    });

    it('falls back to a camelCase-to-sentence-case splitter for unmapped keys', () => {
        expect(humanizeThemeTokenLabel('someFutureToken')).toBe('Some future token');
        expect(humanizeThemeTokenLabel('abcXYZDef')).toBe('Abc xyz def');
    });

    it('returns the key unchanged when it has no case boundaries and is unmapped', () => {
        expect(humanizeThemeTokenLabel('unmappedkey')).toBe('Unmappedkey');
    });
});
