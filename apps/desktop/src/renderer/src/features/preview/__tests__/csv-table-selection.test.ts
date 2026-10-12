import { describe, expect, it } from 'vitest';

import {
    isCellInBounds,
    nextTableRowSelection,
    nextTableSelection,
    serializeTsv,
    tableSelectionBounds,
    tableSelectionText,
    tsvField,
} from '../csv-table-selection';

const rows = [
    ['a1', 'b1', 'c1'],
    ['a2', 'say "hi"', 'c2'],
    ['a3', 'two\nlines', 'tab\there'],
];

describe('tsvField', () => {
    it('keeps a plain value as is', () => {
        expect(tsvField('plain value, with comma')).toBe('plain value, with comma');
        expect(tsvField('')).toBe('');
    });

    it('quotes a value with a tab, line break, or quote and doubles inner quotes', () => {
        expect(tsvField('tab\there')).toBe('"tab\there"');
        expect(tsvField('two\nlines')).toBe('"two\nlines"');
        expect(tsvField('cr\rhere')).toBe('"cr\rhere"');
        expect(tsvField('say "hi"')).toBe('"say ""hi"""');
    });
});

describe('serializeTsv', () => {
    it('joins fields with tabs and records with line breaks, without a trailing line break', () => {
        expect(
            serializeTsv([
                ['a', 'b'],
                ['c', 'd'],
            ]),
        ).toBe('a\tb\nc\td');
        expect(serializeTsv([rows[2]])).toBe('a3\t"two\nlines"\t"tab\there"');
    });

    it('keeps empty cells as empty fields', () => {
        expect(serializeTsv([['', 'x', '']])).toBe('\tx\t');
    });
});

describe('table selection', () => {
    it('starts a single-cell range on a click and extends it from the anchor on a Shift click', () => {
        const first = nextTableSelection(undefined, { row: 2, column: 1 }, false);
        expect(first).toEqual({ anchor: { row: 2, column: 1 }, focus: { row: 2, column: 1 } });
        const extended = nextTableSelection(first, { row: 0, column: 2 }, true);
        expect(tableSelectionBounds(extended)).toEqual({ top: 0, bottom: 2, left: 1, right: 2 });
        expect(nextTableSelection(extended, { row: 1, column: 0 }, false).anchor).toEqual({
            row: 1,
            column: 0,
        });
    });

    it('selects whole rows from the row number and extends the row range on a Shift click', () => {
        const row = nextTableRowSelection(undefined, 1, 3, false);
        expect(tableSelectionBounds(row)).toEqual({ top: 1, bottom: 1, left: 0, right: 2 });
        expect(tableSelectionBounds(nextTableRowSelection(row, 2, 3, true))).toEqual({
            top: 1,
            bottom: 2,
            left: 0,
            right: 2,
        });
    });

    it('tells whether a cell is inside the range', () => {
        const bounds = { top: 1, bottom: 2, left: 0, right: 1 };
        expect(isCellInBounds(bounds, 2, 1)).toBe(true);
        expect(isCellInBounds(bounds, 0, 1)).toBe(false);
        expect(isCellInBounds(bounds, 1, 2)).toBe(false);
        expect(isCellInBounds(undefined, 0, 0)).toBe(false);
    });
});

describe('tableSelectionText', () => {
    it('copies a single cell as its raw value', () => {
        const selection = nextTableSelection(undefined, { row: 1, column: 1 }, false);
        expect(tableSelectionText(rows, [0, 1, 2], selection)).toBe('say "hi"');
    });

    it('copies a range as TSV in view order', () => {
        const selection = {
            anchor: { row: 0, column: 1 },
            focus: { row: 1, column: 2 },
        };
        // The view shows the file's rows reversed, so view row 0 is file row 2.
        expect(tableSelectionText(rows, [2, 1, 0], selection)).toBe(
            '"two\nlines"\t"tab\there"\n"say ""hi"""\tc2',
        );
    });
});
