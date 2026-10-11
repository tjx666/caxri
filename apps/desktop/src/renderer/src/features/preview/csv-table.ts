import { filePreviewExtension } from '@caxri/protocol';
import Papa from 'papaparse';

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

function columnLabel(value: string | undefined, index: number): string {
    const label = value?.trim();
    if (label) return label;
    return `Column ${index + 1}`;
}

/**
 * Parses CSV or TSV text into the table the preview shows.
 *
 * Quoting, escaped quotes, delimiters inside quotes, and line breaks inside a quoted field follow RFC 4180 through Papa
 * Parse. A malformed record (an unclosed quote, say) is reported as an issue rather than thrown: the reader still sees
 * every record the parser could recover, the way a spreadsheet opens a damaged file.
 */
export function parseDelimitedTable(source: string, path: string): DelimitedTable {
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
        columnLabel(records[0]?.[index], index),
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
            if (!NUMERIC_CELL.test(cell) || !/\d/.test(cell)) return false;
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

function countLabel(count: number, noun: string): string {
    return `${count.toLocaleString('en-US')} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * The status line under the table: its size, and what the bounds cut off.
 */
export function describeTableSize(table: DelimitedTable): string {
    const size = `${countLabel(table.rows.length, 'row')} × ${countLabel(table.header.length, 'column')}`;
    const limits = [
        table.truncatedRows && `first ${MAX_TABLE_ROWS.toLocaleString('en-US')} rows shown`,
        table.truncatedColumns &&
            `first ${MAX_TABLE_COLUMNS.toLocaleString('en-US')} columns shown`,
    ].filter(Boolean);
    return limits.length > 0 ? `${size} (${limits.join(', ')})` : size;
}

/**
 * The warning above the table when the parser had to recover, naming the first issue so the reader knows where to look
 * in the source.
 */
export function describeTableIssues(table: DelimitedTable): string | undefined {
    const first = table.issues.at(0);
    if (!first) return undefined;
    const location = first.row === undefined ? '' : `Row ${first.row.toLocaleString('en-US')}: `;
    const more = table.issueCount > 1 ? ` (${countLabel(table.issueCount - 1, 'more issue')})` : '';
    return `Some rows may be split incorrectly. ${location}${first.message}${more}.`;
}
