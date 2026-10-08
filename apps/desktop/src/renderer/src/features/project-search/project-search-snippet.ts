/**
 * How many lines of context the preview shows on each side of the matching line.
 */
const SEARCH_SNIPPET_CONTEXT_LINES = 4;

/**
 * Longest line the preview renders. A minified bundle is a legitimate search hit and a single line of it can be
 * megabytes; the pane wraps rather than scrolls sideways, so an uncut line would push every other line out of view.
 */
const MAX_SNIPPET_LINE_LENGTH = 400;

export interface SearchSnippetLine {
    /**
     * The line the search matched, which the preview highlights. A name-mode result has no matching line, so a snippet
     * built for one marks none.
     */
    isMatch: boolean;
    /**
     * 1-based, matching what the editor and the result rows show.
     */
    number: number;
    text: string;
}

function clipLine(text: string): string {
    return text.length > MAX_SNIPPET_LINE_LENGTH
        ? `${text.slice(0, MAX_SNIPPET_LINE_LENGTH)}…`
        : text;
}

/**
 * The window of a file the preview pane shows for one result.
 *
 * A file-name result has no line to center on, so it shows the head of the file, which is what tells a reader whether
 * they found the right `index.ts` out of nine. Near either end the window stays the same height by borrowing from the
 * other side, so the pane does not change size as the selection moves through a file.
 */
export function searchSnippetLines(
    content: string,
    matchLine: number | undefined,
    contextLines = SEARCH_SNIPPET_CONTEXT_LINES,
): SearchSnippetLine[] {
    const lines = content.split('\n');
    const height = contextLines * 2 + 1;
    const start =
        matchLine === undefined
            ? 0
            : Math.max(0, Math.min(matchLine - 1 - contextLines, lines.length - height));
    return lines.slice(start, start + height).map((text, index) => ({
        isMatch: matchLine !== undefined && start + index + 1 === matchLine,
        number: start + index + 1,
        text: clipLine(text),
    }));
}
