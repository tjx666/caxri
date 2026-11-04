/**
 * Turns user text into a SQLite `LIKE ... ESCAPE '\'` substring pattern: `%`, `_`, and the escape character match
 * themselves, so a query such as `100%_done` is literal text and never a wildcard.
 */
export function likeSubstringPattern(term: string): string {
    return `%${term.replaceAll(/[%_\\]/gu, (character) => `\\${character}`)}%`;
}
