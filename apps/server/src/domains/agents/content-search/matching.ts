/**
 * Returns one bounded literal-match excerpt, without regex evaluation or raw provider records.
 */
export function contentMatchSnippet(text: string, query: string): string | undefined {
    const index = text.toLowerCase().indexOf(query.toLowerCase());
    if (index === -1) return undefined;
    const start = Math.max(0, index - 60);
    return `${start > 0 ? '…' : ''}${text.slice(start, start + 300).replaceAll(/\s+/gu, ' ')}${start + 300 < text.length ? '…' : ''}`;
}
