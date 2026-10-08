/**
 * One quoted module specifier found in a document, with the editor range covering the text between the quotes. Columns
 * are Monaco's: one-based, and `endColumn` sits just past the last character.
 */
export interface ImportSpecifierMatch {
    endColumn: number;
    lineNumber: number;
    specifier: string;
    startColumn: number;
}

/**
 * Matches the quoted path of an import, re-export, or `require`, deliberately by text rather than by parsing.
 *
 * A syntax tree would be the accurate way to find these, but Monaco's TypeScript worker has no project graph here (see
 * `editor-diagnostics.ts`), and every other language in this family would need its own parser. The cost of the
 * approximation is bounded: only module-shaped specifiers are matched, and a match that does not resolve to a real file
 * never becomes a link, so the worst case of a false positive (a path-like string inside a comment) is an underline on
 * text that would have opened the same file anyway.
 */
const IMPORT_PATTERN =
    /(?<prefix>\b(?:from|import|require)\s*(?:\(\s*)?)(?<quote>['"])(?<specifier>(?![/\\]|[A-Za-z][A-Za-z\d+.-]*:)[^'"\r\n\0]+)\k<quote>/gu;

/**
 * Caps the scan so an unusually long generated line cannot dominate a link pass.
 */
const MAX_SCANNED_LINE_LENGTH = 2_048;

/**
 * Finds module specifiers in document order, excluding absolute paths and URL/builtin schemes.
 *
 * @param lines Document text, already split into lines; index 0 is Monaco's line 1.
 * @param limit Largest number of matches to return, matching the Server's per-request resolution budget.
 */
export function findImportSpecifiers(
    lines: readonly string[],
    limit: number,
): ImportSpecifierMatch[] {
    const matches: ImportSpecifierMatch[] = [];
    for (const [index, line] of lines.entries()) {
        if (line.length > MAX_SCANNED_LINE_LENGTH) continue;
        IMPORT_PATTERN.lastIndex = 0;
        let match = IMPORT_PATTERN.exec(line);
        while (match) {
            const { prefix, specifier } = match.groups as { prefix: string; specifier: string };
            // `+ 1` twice: once to step past the opening quote, once because Monaco columns are one-based.
            const startColumn = match.index + prefix.length + 2;
            matches.push({
                endColumn: startColumn + specifier.length,
                lineNumber: index + 1,
                specifier,
                startColumn,
            });
            if (matches.length >= limit) return matches;
            match = IMPORT_PATTERN.exec(line);
        }
    }
    return matches;
}

/**
 * The specifier the caret sits on, for the keyboard path that opens an import without ⌘-clicking it.
 *
 * Both edges count as a hit: a caret resting just past the closing character of `'./errors'` still reads to the user as
 * being on that path, and refusing there would make the command feel like it missed.
 */
export function importSpecifierAtPosition(
    matches: readonly ImportSpecifierMatch[],
    lineNumber: number,
    column: number,
): ImportSpecifierMatch | undefined {
    return matches.find(
        (match) =>
            match.lineNumber === lineNumber &&
            column >= match.startColumn &&
            column <= match.endColumn,
    );
}
