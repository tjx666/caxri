import { describe, expect, it } from 'vitest';

import { parseTrashedPath } from '../local-item';

describe('parseTrashedPath', () => {
    it('reads the destination the macOS trash tool reports', () => {
        expect(parseTrashedPath('# Moved "/tmp/a.txt" to "/Users/me/.Trash/a.txt"\n')).toBe(
            '/Users/me/.Trash/a.txt',
        );
    });

    it('keeps a destination renamed to avoid a collision, and spaces in names', () => {
        expect(
            parseTrashedPath('# Moved "/tmp/my file.txt" to "/Users/me/.Trash/my file 2.txt"\n'),
        ).toBe('/Users/me/.Trash/my file 2.txt');
    });

    it('is not shifted by a source path containing " to "', () => {
        expect(parseTrashedPath('# Moved "/tmp/a" to "b" to "/Users/me/.Trash/b"\n')).toBe(
            '/Users/me/.Trash/b',
        );
    });

    it('returns nothing for output without a move line', () => {
        expect(parseTrashedPath('')).toBeUndefined();
        expect(parseTrashedPath('trash: something went wrong\n')).toBeUndefined();
    });
});
