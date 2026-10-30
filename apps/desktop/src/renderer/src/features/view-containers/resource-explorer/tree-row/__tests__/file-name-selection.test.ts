import { describe, expect, it } from 'vitest';

import { renameSelectionEnd } from '../file-name-selection';

describe('renameSelectionEnd', () => {
    it.each([
        ['report.final.pdf', true, 12],
        ['notes.md', true, 5],
        ['.gitignore', true, 10],
        ['Makefile', true, 8],
        ['trailing.', true, 8],
        ['v1.2', false, 4],
        ['', true, 0],
    ])('%s (file: %s) selects up to %i', (name, isFile, end) => {
        expect(renameSelectionEnd(name, isFile)).toBe(end);
    });
});
