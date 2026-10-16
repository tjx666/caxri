import { defaultFilter } from 'cmdk';

/**
 * Keep cmdk's matching rules while letting React own the complete result order, including rows that become visible
 * again when a query is shortened. Equal scores keep their source order.
 */
export function rankPaletteEntries<T extends { value: string }>(
    entries: readonly T[],
    search: string,
): T[] {
    const query = search.trim();
    if (!query) return [...entries];
    return entries
        .map((entry, index) => ({ entry, index, score: defaultFilter(entry.value, query) }))
        .filter(({ score }) => score > 0)
        .toSorted((left, right) => right.score - left.score || left.index - right.index)
        .map(({ entry }) => entry);
}
