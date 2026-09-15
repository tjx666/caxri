/**
 * Shared `cmdk` filter for the status-bar pickers.
 *
 * Match contiguous text instead of `cmdk`'s default fuzzy score: branch names and worktree paths share long prefixes
 * (`fix/`, `feat/`, one common parent directory), and fuzzy matching turns nearly every row into a hit. An empty query
 * keeps every row, including action rows such as `Show all worktrees…` that carry no searchable keywords.
 *
 * `keywords` wins when the caller supplies richer haystacks than the item value (branch, title, path); otherwise the
 * item value is the haystack.
 */
export function pickerSearchScore(value: string, search: string, keywords: string[] = []): number {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return 1;
    const haystack = keywords.length > 0 ? keywords : [value];
    return haystack.some((entry) => entry.toLocaleLowerCase().includes(query)) ? 1 : 0;
}
