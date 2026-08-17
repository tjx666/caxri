import { describe, expect, it } from 'vitest';

import { cssFontFamilyEntry } from '../css-font-family';

describe('cssFontFamilyEntry', () => {
    it('returns undefined for unset or blank input', () => {
        expect(cssFontFamilyEntry(null)).toBeUndefined();
        expect(cssFontFamilyEntry(undefined)).toBeUndefined();
        expect(cssFontFamilyEntry(' '.repeat(3))).toBeUndefined();
    });

    it('passes single-word names through untouched', () => {
        expect(cssFontFamilyEntry('Menlo')).toBe('Menlo');
    });

    it('quotes bare names containing spaces', () => {
        expect(cssFontFamilyEntry('JetBrains Mono')).toBe('"JetBrains Mono"');
    });

    it('keeps pre-quoted values and stacks untouched', () => {
        expect(cssFontFamilyEntry('"Fira Code"')).toBe('"Fira Code"');
        expect(cssFontFamilyEntry('Fira Code, monospace')).toBe('Fira Code, monospace');
    });
});
