/**
 * The slice of Papa Parse's API the CSV table view uses (see `features/preview/csv-table.ts`).
 *
 * Declared here instead of installing `@types/papaparse`: that package references `@types/node` for its stream API,
 * which would put Node's `setTimeout` (returning `Timeout`, not `number`) into every Renderer file. Kept import-free so
 * this stays an ambient module declaration rather than an augmentation.
 */
declare module 'papaparse' {
    interface ParseConfig {
        /** An empty string auto-detects among comma, tab, pipe, semicolon, and the record/unit separators. */
        delimiter?: string;
        /** Stops after this many records. */
        preview?: number;
        skipEmptyLines?: boolean | 'greedy';
    }

    interface ParseError {
        type: 'Delimiter' | 'FieldMismatch' | 'Quotes';
        code:
            | 'InvalidQuotes'
            | 'MissingQuotes'
            | 'TooFewFields'
            | 'TooManyFields'
            | 'UndetectableDelimiter';
        message: string;
        /** Zero-based index of the record the error belongs to, when it belongs to one. */
        row?: number;
    }

    interface ParseResult<T> {
        data: T[];
        errors: ParseError[];
        meta: { delimiter: string; truncated: boolean };
    }

    const Papa: {
        parse<T>(input: string, config?: ParseConfig): ParseResult<T>;
    };
    export default Papa;
}
