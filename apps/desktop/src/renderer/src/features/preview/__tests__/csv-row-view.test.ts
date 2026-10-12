import { describe, expect, it } from 'vitest';

import {
    filterTableRows,
    nextTableSort,
    sortTableRows,
    tableRowSearchText,
    tableRowView,
} from '../csv-row-view';
import { numericCellValue, parseDelimitedTable } from '../csv-table';

const table = parseDelimitedTable(
    'name,score\nitem10,"1,200"\nItem2,15%\nitem1,\nalpha,-3.5\nbeta,n/a\ngamma,1e2\n',
    '/p/data.csv',
);

const names = (order: readonly number[]) => order.map((index) => table.rows[index][0]);

describe('nextTableSort', () => {
    it('cycles a column through ascending, descending, and file order', () => {
        const ascending = nextTableSort(undefined, 1);
        expect(ascending).toEqual({ column: 1, direction: 'ascending' });
        const descending = nextTableSort(ascending, 1);
        expect(descending).toEqual({ column: 1, direction: 'descending' });
        expect(nextTableSort(descending, 1)).toBeUndefined();
    });

    it('starts another column at ascending', () => {
        expect(nextTableSort({ column: 0, direction: 'descending' }, 1)).toEqual({
            column: 1,
            direction: 'ascending',
        });
    });
});

describe('numericCellValue', () => {
    it('reads grouped, signed, exponent, and percent values', () => {
        expect(numericCellValue('1,200')).toBe(1200);
        expect(numericCellValue('-3.5')).toBe(-3.5);
        expect(numericCellValue('1e2')).toBe(100);
        expect(numericCellValue('15%')).toBe(15);
        expect(numericCellValue('n/a')).toBeUndefined();
        expect(numericCellValue('')).toBeUndefined();
    });
});

describe('sortTableRows', () => {
    it('sorts a numeric column by value with text after numbers and blanks last', () => {
        expect(table.numericColumns[1]).toBe(false);
        const numeric = { rows: table.rows, numericColumns: [false, true] };

        expect(names(sortTableRows(numeric, { column: 1, direction: 'ascending' }))).toEqual([
            'alpha',
            'Item2',
            'gamma',
            'item10',
            'beta',
            'item1',
        ]);
        expect(names(sortTableRows(numeric, { column: 1, direction: 'descending' }))).toEqual([
            'beta',
            'item10',
            'gamma',
            'Item2',
            'alpha',
            'item1',
        ]);
    });

    it('sorts text naturally and without regard to case', () => {
        expect(names(sortTableRows(table, { column: 0, direction: 'ascending' }))).toEqual([
            'alpha',
            'beta',
            'gamma',
            'item1',
            'Item2',
            'item10',
        ]);
    });

    it('keeps equal cells in file order', () => {
        const rows = [['b'], ['a'], ['b'], ['a']];
        expect(
            sortTableRows(
                { rows, numericColumns: [false] },
                { column: 0, direction: 'descending' },
            ),
        ).toEqual([0, 2, 1, 3]);
    });
});

describe('filterTableRows', () => {
    const searchText = tableRowSearchText(table.rows);

    it('keeps rows where any cell contains the query, ignoring case', () => {
        expect(names(filterTableRows([0, 1, 2, 3, 4, 5], searchText, 'ITEM'))).toEqual([
            'item10',
            'Item2',
            'item1',
        ]);
        expect(names(filterTableRows([0, 1, 2, 3, 4, 5], searchText, '15%'))).toEqual(['Item2']);
    });

    it('never matches across two cells', () => {
        expect(filterTableRows([0, 1, 2, 3, 4, 5], searchText, 'alpha-3')).toEqual([]);
    });

    it('keeps every row for a blank query', () => {
        expect(filterTableRows([2, 0], searchText, '  ')).toEqual([2, 0]);
    });
});

describe('tableRowView', () => {
    it('filters the sorted order and keeps source row indexes for the gutter', () => {
        const order = tableRowView(
            table,
            tableRowSearchText(table.rows),
            { column: 0, direction: 'descending' },
            'item',
        );

        expect(order).toEqual([0, 1, 2]);
        expect(names(order)).toEqual(['item10', 'Item2', 'item1']);
    });
});
