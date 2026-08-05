import { describe, expect, it } from 'vitest';

import { terminalSizeChanged } from './terminal-size';

describe('Terminal resize deduplication', () => {
    it('suppresses an unchanged grid while preserving either dimension change', () => {
        expect(terminalSizeChanged(undefined, { cols: 100, rows: 30 })).toBe(true);
        expect(terminalSizeChanged({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(false);
        expect(terminalSizeChanged({ cols: 100, rows: 30 }, { cols: 101, rows: 30 })).toBe(true);
        expect(terminalSizeChanged({ cols: 100, rows: 30 }, { cols: 100, rows: 31 })).toBe(true);
    });
});
