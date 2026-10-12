import type { DelimitedTable } from './csv-table';
import { numericCellValue } from './csv-table';

type TableSortDirection = 'ascending' | 'descending';

/**
 * One sorted column. Sorting is single-column on purpose: a header click replaces the previous sort.
 */
export interface TableSort {
    column: number;
    direction: TableSortDirection;
}

/**
 * What clicking a column header does next: an unsorted column sorts ascending, then descending, then back to the file's
 * own order. Clicking another column starts that column at ascending.
 */
export function nextTableSort(
    current: TableSort | undefined,
    column: number,
): TableSort | undefined {
    if (current?.column !== column) return { column, direction: 'ascending' };
    return current.direction === 'ascending' ? { column, direction: 'descending' } : undefined;
}

/**
 * Natural, case-insensitive text order, so `item2` sorts before `item10` the way a file browser lists them. One shared
 * collator, because building one per comparison would dominate a 50,000-row sort.
 */
const textCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

type SortKey =
    { kind: 'number'; value: number } | { kind: 'text'; value: string } | { kind: 'blank' };

function sortKey(cell: string, isNumeric: boolean): SortKey {
    const trimmed = cell.trim();
    if (!trimmed) return { kind: 'blank' };
    if (isNumeric) {
        const value = numericCellValue(trimmed);
        if (value !== undefined) return { kind: 'number', value };
    }
    return { kind: 'text', value: trimmed };
}

const KIND_RANK = { number: 0, text: 1, blank: 2 } as const;

function compareKeys(left: SortKey, right: SortKey): number {
    if (left.kind === 'number' && right.kind === 'number') return left.value - right.value;
    if (left.kind === 'text' && right.kind === 'text')
        return textCollator.compare(left.value, right.value);
    return KIND_RANK[left.kind] - KIND_RANK[right.kind];
}

/**
 * Source row indexes in sorted order. A numeric column compares by value, any other by natural text order. Blank cells
 * stay at the bottom in both directions, as they do in a spreadsheet, and in a numeric column a stray text cell sorts
 * after the numbers. The sort is stable, so equal cells keep their file order.
 */
export function sortTableRows(
    table: Pick<DelimitedTable, 'numericColumns' | 'rows'>,
    sort: TableSort,
): number[] {
    const isNumeric = table.numericColumns[sort.column] ?? false;
    const keys = table.rows.map((row) => sortKey(row[sort.column] ?? '', isNumeric));
    const sign = sort.direction === 'ascending' ? 1 : -1;
    return table.rows
        .map((_, index) => index)
        .toSorted((left, right) => {
            const leftKey = keys[left];
            const rightKey = keys[right];
            const order = compareKeys(leftKey, rightKey);
            // Blanks rank last whichever way the column is sorted, so only a comparison between values flips.
            const isBlankInvolved = leftKey.kind === 'blank' || rightKey.kind === 'blank';
            return (isBlankInvolved ? order : order * sign) || left - right;
        });
}

/**
 * Each row's searchable text, lowercased once per parse so a keystroke in the filter costs one substring scan per row.
 * Cells are joined with a NUL, which a typed query cannot contain, so a match never spans two cells.
 */
export function tableRowSearchText(rows: ReadonlyArray<readonly string[]>): string[] {
    return rows.map((row) => row.join('\0').toLocaleLowerCase());
}

/**
 * Keeps the rows, in the given order, where any cell contains the query, ignoring case. A blank query keeps every row.
 */
export function filterTableRows(
    order: readonly number[],
    searchText: readonly string[],
    query: string,
): number[] {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return [...order];
    return order.filter((index) => searchText[index].includes(needle));
}

/**
 * The rows the table shows, as source row indexes: sorted when a sort is set, then filtered. Rows keep their source
 * index so the gutter can keep showing the file's own row numbers.
 */
export function tableRowView(
    table: Pick<DelimitedTable, 'numericColumns' | 'rows'>,
    searchText: readonly string[],
    sort: TableSort | undefined,
    query: string,
): number[] {
    const order = sort ? sortTableRows(table, sort) : table.rows.map((_, index) => index);
    return filterTableRows(order, searchText, query);
}
