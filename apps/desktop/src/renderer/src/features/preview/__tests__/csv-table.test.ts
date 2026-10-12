import { describe, expect, it } from 'vitest';

import {
    cellDisplayWidth,
    describeTableIssues,
    describeTableLimits,
    describeTableSize,
    isCellClipped,
    MAX_TABLE_COLUMNS,
    MAX_TABLE_ROWS,
    parseDelimitedTable,
    rowNumberGutterWidth,
} from '../csv-table';

describe('parseDelimitedTable', () => {
    it('keeps delimiters, escaped quotes, and line breaks inside quoted fields', () => {
        const table = parseDelimitedTable(
            'city,note\n"Lisbon, PT","said ""hi""\nthen left"\n',
            '/p/data.csv',
        );

        expect(table.header).toEqual(['city', 'note']);
        expect(table.rows).toEqual([['Lisbon, PT', 'said "hi"\nthen left']]);
        expect(table.issueCount).toBe(0);
    });

    it('splits a TSV on tabs even when its cells contain commas', () => {
        const table = parseDelimitedTable('name\tamount\nwidget, large\t1,200\n', '/p/data.tsv');

        expect(table.rows).toEqual([['widget, large', '1,200']]);
    });

    it('detects a semicolon-separated CSV', () => {
        const table = parseDelimitedTable('item;price\nbolt;1,5\n', '/p/export.csv');

        expect(table.header).toEqual(['item', 'price']);
        expect(table.rows).toEqual([['bolt', '1,5']]);
    });

    it('strips a byte-order mark and skips blank lines', () => {
        const table = parseDelimitedTable('﻿id,name\n\n1,Ada\n\n', '/p/people.csv');

        expect(table.header).toEqual(['id', 'name']);
        expect(table.rows).toEqual([['1', 'Ada']]);
    });

    it('pads ragged records and names blank header cells by position', () => {
        const table = parseDelimitedTable('a,,c\n1\n1,2,3,4\n', '/p/ragged.csv');

        expect(table.header).toEqual(['a', 'Column 2', 'c', 'Column 4']);
        expect(table.rows).toEqual([
            ['1', '', '', ''],
            ['1', '2', '3', '4'],
        ]);
    });

    it('reports an unclosed quote with its data row and keeps what it recovered', () => {
        const table = parseDelimitedTable('a,b\n1,2\n3,"open\n4,5\n', '/p/broken.csv');

        expect(table.issueCount).toBe(1);
        expect(table.issues[0]).toEqual({ row: 2, message: 'Quoted field unterminated' });
        expect(table.rows[0]).toEqual(['1', '2']);
    });

    it('does not treat a single-column file as a parse issue', () => {
        const table = parseDelimitedTable('name\nAda\nGrace\n', '/p/names.csv');

        expect(table.header).toEqual(['name']);
        expect(table.issueCount).toBe(0);
    });

    it('right-aligns only columns whose sampled cells are all numbers', () => {
        const table = parseDelimitedTable(
            'id,amount,share,code,label\n1,"1,200.50",12%,007A,x\n2,-3e2,4.5%,008B,\n3,,0.1%,009C,y\n',
            '/p/numbers.csv',
        );

        expect(table.numericColumns).toEqual([true, true, true, false, false]);
    });

    it('caps rows and columns and says so', () => {
        const rows = Array.from({ length: MAX_TABLE_ROWS + 5 }, (_, index) => `${index}`).join(
            '\n',
        );
        const tall = parseDelimitedTable(`n\n${rows}\n`, '/p/tall.csv');
        expect(tall.rows).toHaveLength(MAX_TABLE_ROWS);
        expect(tall.truncatedRows).toBe(true);

        const wide = parseDelimitedTable(
            `${Array.from({ length: MAX_TABLE_COLUMNS + 3 }, (_, index) => `c${index}`).join(',')}\n`,
            '/p/wide.csv',
        );
        expect(wide.header).toHaveLength(MAX_TABLE_COLUMNS);
        expect(wide.truncatedColumns).toBe(true);
        expect(wide.truncatedRows).toBe(false);
    });

    it('sizes columns from content within a readable band', () => {
        const table = parseDelimitedTable(`a,b\n1,${'x'.repeat(200)}\n`, '/p/widths.csv');

        expect(table.columnWidths).toEqual([4, 40]);
    });
});

describe('cellDisplayWidth', () => {
    it('counts East Asian characters as two columns', () => {
        expect(cellDisplayWidth('abc')).toBe(3);
        expect(cellDisplayWidth('上海')).toBe(4);
    });
});

describe('table descriptions', () => {
    it('summarizes size, and warns separately about the bounds that cut the table off', () => {
        const one = parseDelimitedTable('a\n1\n', '/p/one.csv');
        expect(describeTableSize(one)).toBe('1 row × 1 column');
        expect(describeTableLimits(one)).toBeUndefined();
        const rows = Array.from({ length: MAX_TABLE_ROWS + 1 }, () => '1,2').join('\n');
        const tall = parseDelimitedTable(`a,b\n${rows}\n`, '/p/tall.csv');
        expect(describeTableSize(tall)).toBe('50,000 rows × 2 columns');
        expect(describeTableSize(tall, undefined, 1_234)).toBe('1,234 of 50,000 rows × 2 columns');
        expect(describeTableLimits(tall)).toBe('Only the first 50,000 rows are shown.');
        expect(describeTableLimits({ ...tall, truncatedColumns: true })).toBe(
            'Only the first 50,000 rows and 256 columns are shown.',
        );
    });

    it('sizes the row-number gutter for the largest row number', () => {
        expect(rowNumberGutterWidth(9)).toBe('calc(2ch + 19px)');
        expect(rowNumberGutterWidth(100)).toBe('calc(3ch + 19px)');
        expect(rowNumberGutterWidth(50_000)).toBe('calc(5ch + 19px)');
    });

    it('flags cells wider than their column or holding a line break', () => {
        expect(isCellClipped('short', 10)).toBe(false);
        expect(isCellClipped('x'.repeat(41), 40)).toBe(true);
        expect(isCellClipped('said "hi"\nthen left', 40)).toBe(true);
    });

    it('names the first parse issue and counts the rest', () => {
        expect(describeTableIssues(parseDelimitedTable('a,b\n1,2\n', '/p/clean.csv'))).toBe(
            undefined,
        );
        expect(
            describeTableIssues(parseDelimitedTable('a,b\n1,2\n3,"open\n', '/p/broken.csv')),
        ).toBe('Some rows may be split incorrectly. Row 2: Quoted field unterminated.');
    });
});
