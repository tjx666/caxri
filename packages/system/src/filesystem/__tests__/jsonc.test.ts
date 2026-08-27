import { describe, expect, it } from 'vitest';

import { parseJsonc } from '../jsonc';

describe('parseJsonc', () => {
    it('parses valid JSONC with comments and trailing commas', () => {
        const source = '{\n  // comment\n  "a": 1,\n  "b": [1, 2, 3,],\n}\n';
        expect(parseJsonc(source)).toEqual({ a: 1, b: [1, 2, 3] });
    });

    it('reports the line and column of a single-line parse failure', () => {
        // `{ "a": }` is missing its value; the parser reports `ValueExpected` at the `}` (offset 7),
        // which is column 8 on line 1.
        expect(() => parseJsonc('{ "a": }')).toThrow('ValueExpected at line 1, column 8');
    });

    it('reports the line and column of a multi-line parse failure', () => {
        // Missing comma between properties on separate lines; the parser reports `CommaExpected` at
        // the start of the third line (`  "b": 2`), which is line 3, column 3.
        const source = '{\n  "a": 1\n  "b": 2\n}';
        expect(() => parseJsonc(source)).toThrow('CommaExpected at line 3, column 3');
    });

    it('reports an unterminated string on the line where the string starts', () => {
        const source = '{\n  "a": "oops\n}';
        expect(() => parseJsonc(source)).toThrow('UnexpectedEndOfString at line 2, column 8');
    });

    it('throws a plain Error, not a structured CaxriError, on malformed input', () => {
        expect(() => parseJsonc('{ "a": }')).toThrow(Error);
    });
});
