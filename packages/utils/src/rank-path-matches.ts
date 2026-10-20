import { sortedCopy } from './sorted-copy.js';

function basename(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * How well the file name matches the query: 4 for the whole name, 3 for the name without its extension, 2 for a name
 * that starts with it, 1 for a name that contains it, and 0 for a hit that matched only a directory segment.
 */
function nameScore(name: string, query: string): number {
    const candidate = name.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    if (!needle || !candidate.includes(needle)) return 0;
    if (candidate === needle) return 4;
    const dot = candidate.lastIndexOf('.');
    if (dot > 0 && candidate.slice(0, dot) === needle) return 3;
    return candidate.startsWith(needle) ? 2 : 1;
}

/**
 * Orders Project-relative (`/`-separated) path hits of a name search by relevance and keeps the first `limit`. The
 * strongest signal is how the file name itself matched; a hit that only matched a directory segment ranks below every
 * name hit. Ties break toward the shallower path, then the shorter name, then a stable path comparison, so repeating a
 * query cannot reshuffle a list under the user's selection. Quick open and the Chat composer's `@` file list share it.
 */
export function rankPathMatches<T>(
    items: readonly T[],
    relativePathOf: (item: T) => string,
    query: string,
    limit: number,
): T[] {
    const scored = items.map((item) => {
        const path = relativePathOf(item);
        const name = basename(path);
        return {
            depth: path.split('/').length,
            item,
            name,
            path,
            score: nameScore(name, query),
        };
    });
    return sortedCopy(
        scored,
        (left, right) =>
            right.score - left.score ||
            left.depth - right.depth ||
            left.name.length - right.name.length ||
            left.path.localeCompare(right.path),
    )
        .slice(0, limit)
        .map(({ item }) => item);
}
