import { describe, expect, it } from 'vitest';

import {
    clampTableSelection,
    isCellInBounds,
    moveActiveCell,
    nextTableKeyboardSelection,
    nextTableRowSelection,
    nextTableSelection,
    revealScrollOffset,
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

describe('moveActiveCell', () => {
    const bounds = { rows: 50_000, columns: 5 };
    const middle = { row: 100, column: 2 };
    const key = (name: string, modifiers: { metaKey?: boolean; ctrlKey?: boolean } = {}) => ({
        key: name,
        metaKey: modifiers.metaKey ?? false,
        ctrlKey: modifiers.ctrlKey ?? false,
    });

    it('moves one cell with each arrow', () => {
        expect(moveActiveCell(middle, key('ArrowUp'), bounds, 10)).toEqual({ row: 99, column: 2 });
        expect(moveActiveCell(middle, key('ArrowDown'), bounds, 10)).toEqual({
            row: 101,
            column: 2,
        });
        expect(moveActiveCell(middle, key('ArrowLeft'), bounds, 10)).toEqual({
            row: 100,
            column: 1,
        });
        expect(moveActiveCell(middle, key('ArrowRight'), bounds, 10)).toEqual({
            row: 100,
            column: 3,
        });
    });

    it('stops at all four edges', () => {
        expect(moveActiveCell({ row: 0, column: 2 }, key('ArrowUp'), bounds, 10)).toEqual({
            row: 0,
            column: 2,
        });
        expect(moveActiveCell({ row: 49_999, column: 2 }, key('ArrowDown'), bounds, 10)).toEqual({
            row: 49_999,
            column: 2,
        });
        expect(moveActiveCell({ row: 7, column: 0 }, key('ArrowLeft'), bounds, 10)).toEqual({
            row: 7,
            column: 0,
        });
        expect(moveActiveCell({ row: 7, column: 4 }, key('ArrowRight'), bounds, 10)).toEqual({
            row: 7,
            column: 4,
        });
    });

    it('jumps to that edge with Cmd+arrow', () => {
        const meta = { metaKey: true };
        expect(moveActiveCell(middle, key('ArrowUp', meta), bounds, 10)).toEqual({
            row: 0,
            column: 2,
        });
        expect(moveActiveCell(middle, key('ArrowDown', meta), bounds, 10)).toEqual({
            row: 49_999,
            column: 2,
        });
        expect(moveActiveCell(middle, key('ArrowLeft', meta), bounds, 10)).toEqual({
            row: 100,
            column: 0,
        });
        expect(moveActiveCell(middle, key('ArrowRight', meta), bounds, 10)).toEqual({
            row: 100,
            column: 4,
        });
    });

    it('goes to the start and end of the row with Home and End', () => {
        expect(moveActiveCell(middle, key('Home'), bounds, 10)).toEqual({ row: 100, column: 0 });
        expect(moveActiveCell(middle, key('End'), bounds, 10)).toEqual({ row: 100, column: 4 });
    });

    it('goes to the first and last cell with Cmd or Ctrl plus Home and End', () => {
        expect(moveActiveCell(middle, key('Home', { metaKey: true }), bounds, 10)).toEqual({
            row: 0,
            column: 0,
        });
        expect(moveActiveCell(middle, key('End', { ctrlKey: true }), bounds, 10)).toEqual({
            row: 49_999,
            column: 4,
        });
    });

    it('moves a page with Page Up and Page Down and stops at the first and last row', () => {
        expect(moveActiveCell(middle, key('PageUp'), bounds, 30)).toEqual({ row: 70, column: 2 });
        expect(moveActiveCell(middle, key('PageDown'), bounds, 30)).toEqual({
            row: 130,
            column: 2,
        });
        expect(moveActiveCell({ row: 5, column: 2 }, key('PageUp'), bounds, 30)).toEqual({
            row: 0,
            column: 2,
        });
        expect(moveActiveCell({ row: 49_990, column: 2 }, key('PageDown'), bounds, 30)).toEqual({
            row: 49_999,
            column: 2,
        });
    });

    it('moves at least one row a page when the viewport holds less than a row', () => {
        expect(moveActiveCell(middle, key('PageDown'), bounds, 0)).toEqual({ row: 101, column: 2 });
    });

    it('ignores other keys and an empty table', () => {
        expect(moveActiveCell(middle, key('a'), bounds, 10)).toBeUndefined();
        expect(moveActiveCell(middle, key('Tab'), bounds, 10)).toBeUndefined();
        expect(
            moveActiveCell({ row: 0, column: 0 }, key('ArrowDown'), { rows: 0, columns: 3 }, 10),
        ).toBeUndefined();
    });
});

describe('nextTableKeyboardSelection', () => {
    const bounds = { rows: 10, columns: 4 };
    const plain = { metaKey: false, ctrlKey: false, shiftKey: false };

    it('starts from the first cell before anything is selected', () => {
        expect(
            nextTableKeyboardSelection(undefined, { ...plain, key: 'ArrowRight' }, bounds, 5),
        ).toEqual({
            anchor: { row: 0, column: 1 },
            focus: { row: 0, column: 1 },
        });
    });

    it('moves a single-cell selection from the focus, dropping a range', () => {
        const range = { anchor: { row: 1, column: 1 }, focus: { row: 3, column: 2 } };
        expect(
            nextTableKeyboardSelection(range, { ...plain, key: 'ArrowDown' }, bounds, 5),
        ).toEqual({
            anchor: { row: 4, column: 2 },
            focus: { row: 4, column: 2 },
        });
    });

    it('keeps the anchor and extends to the moved cell with Shift', () => {
        const range = { anchor: { row: 1, column: 1 }, focus: { row: 3, column: 2 } };
        expect(
            nextTableKeyboardSelection(range, { ...plain, shiftKey: true, key: 'End' }, bounds, 5),
        ).toEqual({ anchor: { row: 1, column: 1 }, focus: { row: 3, column: 3 } });
        expect(
            nextTableKeyboardSelection(
                undefined,
                { ...plain, shiftKey: true, key: 'ArrowDown' },
                bounds,
                5,
            ),
        ).toEqual({ anchor: { row: 0, column: 0 }, focus: { row: 1, column: 0 } });
    });

    it('returns undefined for a key that does not navigate', () => {
        expect(
            nextTableKeyboardSelection(undefined, { ...plain, key: 'Escape' }, bounds, 5),
        ).toBeUndefined();
    });
});

describe('clampTableSelection', () => {
    it('moves a remembered selection inside a table that lost rows', () => {
        expect(
            clampTableSelection(
                { anchor: { row: 2, column: 1 }, focus: { row: 40, column: 9 } },
                { rows: 10, columns: 3 },
            ),
        ).toEqual({ anchor: { row: 2, column: 1 }, focus: { row: 9, column: 2 } });
    });

    it('drops the selection once the table is empty', () => {
        expect(
            clampTableSelection(
                { anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 } },
                { rows: 0, columns: 3 },
            ),
        ).toBeUndefined();
    });
});

describe('revealScrollOffset', () => {
    const viewport = { scroll: 240, viewport: 200, size: 24, inset: 24 };

    it('keeps the offset when the cell is already fully visible', () => {
        expect(revealScrollOffset({ ...viewport, start: 300 })).toBe(240);
    });

    it('scrolls back so a cell above sits just below the pinned header', () => {
        expect(revealScrollOffset({ ...viewport, start: 250 })).toBe(226);
        expect(revealScrollOffset({ ...viewport, start: 24 })).toBe(0);
    });

    it('scrolls forward just enough to show a cell below in full', () => {
        expect(revealScrollOffset({ ...viewport, start: 430 })).toBe(254);
    });
});
