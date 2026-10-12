import { describe, expect, it } from 'vitest';

import {
    clampColumnWidth,
    columnPixels,
    effectiveColumnWidths,
    fitColumnWidth,
    MAX_RESIZED_COLUMN_WIDTH,
    MIN_RESIZED_COLUMN_WIDTH,
    tableGridTemplate,
} from '../csv-column-width';

describe('clampColumnWidth', () => {
    it('keeps a resized width inside the band and rounds it to whole pixels', () => {
        expect(clampColumnWidth(5)).toBe(MIN_RESIZED_COLUMN_WIDTH);
        expect(clampColumnWidth(10_000)).toBe(MAX_RESIZED_COLUMN_WIDTH);
        expect(clampColumnWidth(123.6)).toBe(124);
    });
});

describe('fitColumnWidth', () => {
    it('fits the widest value in any row, past the initial estimate band', () => {
        const rows = Array.from({ length: 900 }, (_, index) => [String(index), '']);
        rows[850][0] = 'x'.repeat(60);
        expect(fitColumnWidth({ header: ['id', 'note'], rows }, 0)).toBe(60);
    });

    it('counts wide East Asian characters as two and keeps the header in view', () => {
        expect(fitColumnWidth({ header: ['name'], rows: [['表格']] }, 0)).toBe(4);
        expect(fitColumnWidth({ header: ['a long header'], rows: [['x']] }, 0)).toBe(13);
    });

    it('stops at the fit ceiling', () => {
        expect(fitColumnWidth({ header: ['n'], rows: [['x'.repeat(500)]] }, 0)).toBe(120);
    });
});

describe('column pixels', () => {
    it('converts `ch` to pixels with the cell padding and the sort arrow room', () => {
        expect(columnPixels(10, 7, false)).toBe(86);
        expect(columnPixels(10, 7, true)).toBe(102);
    });

    it('converts a resized column back to `ch` for clipping', () => {
        expect(effectiveColumnWidths([10, 20], { 1: 86 }, 7)).toEqual([10, 10]);
    });
});

describe('tableGridTemplate', () => {
    it('uses the reader width for a resized column and the estimate for the rest', () => {
        const table = { columnWidths: [10, 20], rows: [['a', 'b']] };
        expect(tableGridTemplate(table, 0, { 1: 300 }).gridTemplateColumns).toBe(
            'calc(2ch + 19px) calc(10ch + 32px) 300px',
        );
    });
});
