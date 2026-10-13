import { filePreviewExtension } from '@caxri/protocol';
import Papa from 'papaparse';

import type { Translate } from '../../i18n';
import { translate } from '../../i18n';
import { formatCount } from '../../lib/locale-format';

/**
 * Data rows the table view parses and shows. Parsing stops at this bound (Papa Parse's `preview`), so a file at the
 * editor's read ceiling costs a bounded amount of main-thread work and memory instead of a full split of every record.
 */
export const MAX_TABLE_ROWS = 50_000;
/**
 * Columns the table view lays out. A record wider than this is almost certainly a wrong delimiter guess or a
 * machine-generated matrix, and laying out thousands of cells per row would stall every scroll frame.
 */
export const MAX_TABLE_COLUMNS = 256;

const MIN_COLUMN_WIDTH = 4;
const MAX_COLUMN_WIDTH = 40;
/**
 * Rows sampled for column widths and numeric alignment. The first rows set the shape a reader sees first; scanning
 * every row would make each keystroke in a large source pay for a decision the sample already makes.
 */
const SAMPLE_ROWS = 500;

/**
 * Plain decimals, signed values, exponents, a trailing percent, and comma-grouped thousands. Anything else (dates,
 * identifiers with leading zeros kept as text, currency symbols) stays left-aligned as text.
 */
const NUMERIC_CELL = /^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:e[+-]?\d+)?%?$/i;

/**
 * The value of a cell the numeric-column test accepts, read the way it displays: grouping commas dropped and a trailing
 * percent kept as the number in front of it. Anything else is not a number.
 */
export function numericCellValue(cell: string): number | undefined {
    const trimmed = cell.trim();
    if (!NUMERIC_CELL.test(trimmed) || !/\d/.test(trimmed)) return undefined;
    const value = Number(trimmed.replaceAll(',', '').replace(/%$/, ''));
    return Number.isFinite(value) ? value : undefined;
}

interface TableParseIssue {
    /**
     * 1-based data row the parser reported, matching the row numbers the table shows; absent for a header issue.
     */
    row?: number;
    message: string;
}

export interface DelimitedTable {
    /**
     * Header labels: the first record, with blank cells named by position so every column stays addressable.
     */
    header: string[];
    /**
     * Data records after the header, each padded or clipped to `header.length` cells.
     */
    rows: string[][];
    /**
     * Width of each column in `ch`, estimated from the header and a sample of rows and clamped to a readable band.
     */
    columnWidths: number[];
    /**
     * Whether every sampled non-empty cell in the column is a number, so the view can right-align it.
     */
    numericColumns: boolean[];
    /**
     * More records exist beyond {@link MAX_TABLE_ROWS}.
     */
    truncatedRows: boolean;
    /**
     * At least one record was wider than {@link MAX_TABLE_COLUMNS}.
     */
    truncatedColumns: boolean;
    /**
     * Total parse issues, of which `issues` keeps the first few for display.
     */
    issueCount: number;
    issues: TableParseIssue[];
}

/**
 * Display width of a cell in `ch`. East Asian ideographs, kana, Hangul, and full-width forms render about two `ch`
 * wide, so counting them as one would clip Chinese or Japanese column content that visibly fits.
 */
export function cellDisplayWidth(value: string): number {
    let width = 0;
    for (const character of value) {
        const code = character.codePointAt(0) ?? 0;
        width += code >= 0x2e_80 && code <= 0xff_60 ? 2 : 1;
    }
    return width;
}

function delimiterFor(path: string): string {
    // An empty delimiter asks Papa Parse to guess among comma, tab, pipe, and semicolon, which covers the
    // semicolon-separated CSV spreadsheets export in locales that use a decimal comma.
    return filePreviewExtension(path) === 'tsv' ? '\t' : '';
}

function columnLabel(value: string | undefined, index: number, t: Translate): string {
    const label = value?.trim();
    if (label) return label;
    return t('preview.table.column', { index: index + 1 });
}

/**
 * Parses CSV or TSV text into the table the preview shows.
 *
 * Quoting, escaped quotes, delimiters inside quotes, and line breaks inside a quoted field follow RFC 4180 through Papa
 * Parse. A malformed record (an unclosed quote, say) is reported as an issue rather than thrown: the reader still sees
 * every record the parser could recover, the way a spreadsheet opens a damaged file.
 */
export function parseDelimitedTable(
    source: string,
    path: string,
    t: Translate = translate,
): DelimitedTable {
    const result = Papa.parse<string[]>(source, {
        delimiter: delimiterFor(path),
        // The header plus one record past the bound, so the view can tell a full table from a truncated one.
        preview: MAX_TABLE_ROWS + 2,
        skipEmptyLines: true,
    });
    const records = result.data;
    const width = Math.min(
        MAX_TABLE_COLUMNS,
        records.reduce((widest, record) => Math.max(widest, record.length), 0),
    );
    const truncatedColumns = records.some((record) => record.length > MAX_TABLE_COLUMNS);
    const header = Array.from({ length: width }, (_, index) =>
        columnLabel(records[0]?.[index], index, t),
    );
    const body = records.slice(1, MAX_TABLE_ROWS + 1);
    const rows = body.map((record) =>
        record.length === width
            ? record
            : Array.from({ length: width }, (_, index) => record[index] ?? ''),
    );
    const sample = rows.slice(0, SAMPLE_ROWS);
    const columnWidths = header.map((label, column) => {
        const widest = sample.reduce(
            (current, row) => Math.max(current, cellDisplayWidth(row[column])),
            cellDisplayWidth(label),
        );
        return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, widest));
    });
    const numericColumns = header.map((_, column) => {
        let isSawNumber = false;
        for (const row of sample) {
            const cell = row[column].trim();
            if (!cell) continue;
            if (numericCellValue(cell) === undefined) return false;
            isSawNumber = true;
        }
        return isSawNumber;
    });
    // A single-column file has nothing to split on; Papa Parse reports that guess as an error, but the table is right.
    const issues = result.errors.filter((error) => error.code !== 'UndetectableDelimiter');
    return {
        header,
        rows,
        columnWidths,
        numericColumns,
        truncatedRows: records.length > MAX_TABLE_ROWS + 1,
        truncatedColumns,
        issueCount: issues.length,
        issues: issues.slice(0, 3).map((error) => ({
            // Papa Parse counts records from 0 with the header as record 0, which is exactly the view's 1-based data row
            // numbering; an issue in the header itself carries no row number.
            ...(error.row !== undefined && error.row > 0 && { row: error.row }),
            message: error.message,
        })),
    };
}

function rowsLabel(count: number, t: Translate): string {
    return t(count === 1 ? 'preview.table.rowsOne' : 'preview.table.rowsOther', {
        count: formatCount(count),
    });
}

function columnsLabel(count: number, t: Translate): string {
    return t(count === 1 ? 'preview.table.columnsOne' : 'preview.table.columnsOther', {
        count: formatCount(count),
    });
}

/**
 * The status line under the table: its size, and while a filter hides rows, how many of them are showing ("12 of 2,000
 * rows"). What the bounds cut off is a warning, not a statistic, and is reported by {@link describeTableLimits} in the
 * warning bar above the table.
 */
export function describeTableSize(
    table: DelimitedTable,
    t: Translate = translate,
    visibleRows: number = table.rows.length,
): string {
    const rows =
        visibleRows === table.rows.length
            ? rowsLabel(table.rows.length, t)
            : t('preview.table.filteredRows', {
                  visible: formatCount(visibleRows),
                  total: rowsLabel(table.rows.length, t),
              });
    return `${rows} × ${columnsLabel(table.header.length, t)}`;
}

/**
 * The warning-bar sentence when parsing stopped at a bound, so the reader knows the table is not the whole file.
 */
export function describeTableLimits(
    table: DelimitedTable,
    t: Translate = translate,
): string | undefined {
    const rows = rowsLabel(MAX_TABLE_ROWS, t);
    const columns = columnsLabel(MAX_TABLE_COLUMNS, t);
    if (table.truncatedRows && table.truncatedColumns)
        return t('preview.table.limitRowsAndColumns', { rows, columns });
    if (table.truncatedRows) return t('preview.table.limitRows', { rows });
    if (table.truncatedColumns) return t('preview.table.limitColumns', { columns });
    return undefined;
}

/**
 * The table view's fixed row height in pixels; the virtualizer and the keyboard's scroll math both step by it.
 */
export const TABLE_ROW_HEIGHT = 24;

/**
 * The sticky header row: a body row's height plus its 1px bottom border. Body rows start below it, so scroll math that
 * assumed a 24px header left the last row 1px under the scroller's bottom edge.
 */
export const TABLE_HEADER_HEIGHT = TABLE_ROW_HEIGHT + 1;

/**
 * The gutter's pixels beyond its digits: padding, border, and figure slack.
 */
export const ROW_NUMBER_GUTTER_EXTRA = 19;

/**
 * Width of the row-number gutter, from the digit count of the largest row number it shows.
 *
 * The 16px is the cell's horizontal padding, 1px is its right border (the cell is border-box, so the border is taken
 * from the same track), and the extra 2px absorbs UI fonts whose tabular figures are a little wider than the `0` that
 * defines `ch`. Without the border and slack, three-digit row numbers clip to "1…".
 */
export function rowNumberGutterWidth(rowCount: number): string {
    return `calc(${rowNumberDigits(rowCount)}ch + ${ROW_NUMBER_GUTTER_EXTRA}px)`;
}

/**
 * Digits the row-number gutter is sized for: the largest row number's, and at least two.
 */
export function rowNumberDigits(rowCount: number): number {
    return Math.max(2, String(Math.max(1, rowCount)).length);
}

/**
 * Whether a cell's text does not fit its column, so the view offers the full value on hover. Estimated from the same
 * display width the column was sized with, so no cell has to be measured; a value with a line break always counts,
 * because the one-line cell shows it with the break collapsed.
 */
export function isCellClipped(value: string, columnWidth: number): boolean {
    return value.includes('\n') || cellDisplayWidth(value) > columnWidth;
}

/**
 * The warning above the table when the parser had to recover, naming the first issue so the reader knows where to look
 * in the source.
 */
export function describeTableIssues(
    table: DelimitedTable,
    t: Translate = translate,
): string | undefined {
    const first = table.issues.at(0);
    if (!first) return undefined;
    const location =
        first.row === undefined
            ? ''
            : t('preview.table.issueLocation', { row: formatCount(first.row) });
    const moreCount = table.issueCount - 1;
    const more =
        moreCount > 0
            ? t(moreCount === 1 ? 'preview.table.moreIssuesOne' : 'preview.table.moreIssuesOther', {
                  count: formatCount(moreCount),
              })
            : '';
    // Papa Parse's own message stays English: it is the parser's diagnostic, quoted as-is.
    return t('preview.table.issues', { location, message: first.message, more });
}
