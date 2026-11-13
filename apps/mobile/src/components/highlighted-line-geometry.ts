/**
 * The most characters one preview row renders. A minified bundle can hold a whole file on one line, and a row that long
 * is the same oversized `Text` that froze Android before the preview split into rows; the Edit view still holds the
 * full line.
 */
export const PREVIEW_LINE_MAX_CHARS = 2_000;

/**
 * How many monospace columns a line occupies: CJK and other full-width characters take two.
 */
export function lineColumns(line: string): number {
    let columns = 0;
    for (const character of line) columns += (character.codePointAt(0) ?? 0) >= 0x2e_80 ? 2 : 1;
    return columns;
}

/**
 * Cuts a line's tokens to `PREVIEW_LINE_MAX_CHARS` characters, marking the cut with an ellipsis token.
 */
export function clipLineTokens<Token extends { content: string }>(tokens: Token[]): Token[] {
    let remaining = PREVIEW_LINE_MAX_CHARS;
    const clipped: Token[] = [];
    for (const token of tokens) {
        if (token.content.length <= remaining) {
            clipped.push(token);
            remaining -= token.content.length;
            continue;
        }
        clipped.push({ ...token, content: `${token.content.slice(0, remaining)}…` });
        return clipped;
    }
    return clipped;
}

/**
 * The widest row's column count, so the sideways scroll reaches the end of a row that is not mounted yet.
 */
export const widestLineColumns = (code: string): number =>
    code
        .split('\n')
        .reduce(
            (widest, line) =>
                Math.max(widest, lineColumns(line.slice(0, PREVIEW_LINE_MAX_CHARS + 1))),
            0,
        );
