import { describe, expect, it } from 'vitest';

import { pathBasename } from '../path-basename';

describe('pathBasename', () => {
    it('returns the last segment of a posix path', () => {
        expect(pathBasename('/Users/me/code/caxri/README.md')).toBe('README.md');
    });

    it('returns the last segment of a windows path', () => {
        expect(pathBasename(String.raw`C:\Users\me\code\caxri\README.md`)).toBe('README.md');
    });

    it('ignores a trailing separator', () => {
        expect(pathBasename('/Users/me/code/caxri/')).toBe('caxri');
    });

    it('returns a bare name unchanged', () => {
        expect(pathBasename('README.md')).toBe('README.md');
    });

    it('falls back to the input for an empty string', () => {
        expect(pathBasename('')).toBe('');
    });
});
