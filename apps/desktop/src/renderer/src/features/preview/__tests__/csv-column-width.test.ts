import { describe, expect, it } from 'vitest';

import {
    clampColumnWidth,
    columnLeftEdge,
    columnPixels,
    effectiveColumnWidths,
    fitColumnWidth,
    gutterPixels,
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

describe('gutterPixels', () => {
    it('sizes the row-number gutter for the largest row number, at least two digits', () => {
        expect(gutterPixels(5, 7)).toBe(2 * 7 + 19);
        expect(gutterPixels(50_000, 7)).toBe(5 * 7 + 19);
    });
});

describe('columnLeftEdge', () => {
    it('adds the gutter and every column before the given one', () => {
        expect(columnLeftEdge(33, [100, 60, 80], 0)).toBe(33);
        expect(columnLeftEdge(33, [100, 60, 80], 2)).toBe(193);
    });
});
