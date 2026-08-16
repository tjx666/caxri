import { describe, expect, it } from 'vitest';

import { didTerminalSizeChange, terminalSizeWithScrollbarGutter } from './terminal-size';

describe('Terminal scrollbar gutter', () => {
    it('reserves one text column without dropping below xterm minimum dimensions', () => {
        expect(terminalSizeWithScrollbarGutter(undefined)).toBeUndefined();
        expect(terminalSizeWithScrollbarGutter({ cols: 100, rows: 30 })).toEqual({
            cols: 99,
            rows: 30,
        });
        expect(terminalSizeWithScrollbarGutter({ cols: 2, rows: 1 })).toEqual({
            cols: 2,
            rows: 1,
        });
    });
});

describe('Terminal resize deduplication', () => {
    it('suppresses an unchanged grid while preserving either dimension change', () => {
        expect(didTerminalSizeChange(undefined, { cols: 100, rows: 30 })).toBe(true);
        expect(didTerminalSizeChange({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(false);
        expect(didTerminalSizeChange({ cols: 100, rows: 30 }, { cols: 101, rows: 30 })).toBe(true);
        expect(didTerminalSizeChange({ cols: 100, rows: 30 }, { cols: 100, rows: 31 })).toBe(true);
    });
});
