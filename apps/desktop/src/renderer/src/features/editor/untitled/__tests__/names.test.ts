import { untitledEditorTabPath } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    emptyUntitledDocument,
    nextUntitledIndex,
    untitledDisplayName,
    untitledFirstLineName,
    untitledSuggestedFileName,
} from '../names';

describe('nextUntitledIndex', () => {
    it('takes the lowest number no open untitled buffer uses', () => {
        expect(nextUntitledIndex([])).toBe(1);
        expect(
            nextUntitledIndex([
                untitledEditorTabPath(1),
                untitledEditorTabPath(3),
                '/project/Untitled-2',
            ]),
        ).toBe(2);
    });
});

describe('untitledFirstLineName', () => {
    it('names a buffer by its first line with whitespace collapsed', () => {
        expect(untitledFirstLineName('  hello   world \nsecond line')).toBe('hello world');
        expect(untitledFirstLineName('a'.repeat(60))).toBe('a'.repeat(40));
    });

    it('keeps the numbered name until the first line has a letter or digit', () => {
        expect(untitledFirstLineName('')).toBeUndefined();
        expect(untitledFirstLineName('{\n  "a": 1\n}')).toBeUndefined();
        expect(untitledFirstLineName('\nhello')).toBeUndefined();
    });
});

describe('untitledDisplayName', () => {
    it('falls back to the numbered name', () => {
        const t = (key: string, values?: Record<string, unknown>) =>
            `${key}:${String(values?.index)}`;
        expect(untitledDisplayName(untitledEditorTabPath(4), '', t)).toBe('editor.tab.untitled:4');
        expect(untitledDisplayName(untitledEditorTabPath(4), 'notes', t)).toBe('notes');
    });
});

describe('untitledSuggestedFileName', () => {
    it('suggests the display name with the detected extension, safe for a file name', () => {
        expect(untitledSuggestedFileName('print("hi")', 'py')).toBe('print( hi ).py');
        expect(untitledSuggestedFileName('a/b: c', undefined)).toBe('a b c');
        expect(untitledSuggestedFileName('main.py', 'py')).toBe('main.py');
        expect(untitledSuggestedFileName('???', 'md')).toBe('Untitled.md');
    });
});

describe('emptyUntitledDocument', () => {
    it('is a clean, ephemeral, empty buffer', () => {
        expect(emptyUntitledDocument(untitledEditorTabPath(1))).toEqual({
            path: untitledEditorTabPath(1),
            content: '',
            mtimeMs: 0,
            size: 0,
            dirty: false,
            ephemeral: true,
        });
    });
});
