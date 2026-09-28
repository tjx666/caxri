/**
 * Guards for untrusted theme-import documents, shared by the iTerm2, Warp, and VS Code parsers in `index.ts`.
 *
 * Two failure shapes used to escape the importer uncategorized. A parser throwing (`yaml` on a broken document,
 * `jsonc-parser` on an empty file, `plist` on a missing root element) reached the wire as `INTERNAL` with a stack, so
 * an ordinary bad file was logged exactly like a Caxri fault. A degenerate-but-parseable root (`null`, a scalar, an
 * array) threw nothing at all and silently imported a renamed copy of the fallback theme over the user's colors. Both
 * belong to the importer's closed reason set beside `CAPACITY`, `IO`, and the contrast floor.
 */

import { CaxriError } from '@caxri/protocol';

/**
 * Position of a parse failure, for a user repairing a hand-edited theme.
 *
 * The parser's own message is deliberately not forwarded: `yaml` and `plist` both quote the offending source fragment,
 * and diagnostics must exclude file contents. Only the numeric line/column survives — from `yaml`'s structured
 * `linePos`, or from the `line N, column N` suffix `parseJsonc` composes itself.
 *
 * @param error Whatever the format parser threw.
 */
function parseFailurePosition(error: unknown): string {
    if (typeof error !== 'object' || error === null) return '';
    const { linePos } = error as { linePos?: Array<{ col?: unknown; line?: unknown }> };
    const reported = Array.isArray(linePos) ? linePos[0] : undefined;
    if (typeof reported?.line === 'number' && typeof reported.col === 'number') {
        return ` (line ${reported.line}, column ${reported.col})`;
    }
    const composed = error instanceof Error ? /line (\d+), column (\d+)/.exec(error.message) : null;
    return composed ? ` (line ${composed[1]}, column ${composed[2]})` : '';
}

/**
 * Runs one format parser over untrusted source, reclassifying any failure as the importer's own `VALIDATION`.
 *
 * @param parse Format parser invoked on the selected file's contents.
 * @param message User-facing reason, named for the format the file was routed to.
 */
export function parseThemeDocument(parse: () => unknown, message: string): unknown {
    try {
        return parse();
    } catch (error) {
        if (error instanceof CaxriError) throw error;
        throw new CaxriError('VALIDATION', `${message}${parseFailurePosition(error)}`);
    }
}

/**
 * Rejects a root value that parsed cleanly but cannot carry theme colors, before any key is dereferenced.
 *
 * @param value Root value the format parser produced.
 * @param message User-facing reason, named for the format the file was routed to.
 */
export function themeDocumentRoot(value: unknown, message: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new CaxriError('VALIDATION', message);
    }
    return value as Record<string, unknown>;
}
