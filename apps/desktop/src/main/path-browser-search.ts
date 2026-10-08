import { posix } from 'node:path';

/**
 * One Project-wide file-name hit prepared for the path browser list: the file name the user recognizes plus the
 * Project-relative directory that disambiguates same-named files.
 */
export interface RankedProjectMatch {
    directoryLabel: string;
    name: string;
    path: string;
    relativePath: string;
}

/**
 * One in-root name hit after Main revalidated it: `relativePath` is always derived from the validated absolute `path`,
 * never taken from the Server response, so everything that leaves Main is covered by the containment check.
 */
export interface ProjectSearchMatch {
    path: string;
    relativePath: string;
}

/**
 * Enough distinct roots for a realistic dialog session (the covering rule below means typing one word forward stores a
 * single entry) while keeping a long-lived browser from accumulating unbounded result lists.
 */
const MAX_SEARCH_MEMO_ENTRIES = 8;

/**
 * Answers a filter from an earlier complete scan when one exists. `files.search` in `name` mode tests a
 * case-insensitive literal against each Project-relative path, so a filter containing an already-scanned one can only
 * match a subset of that scan's hits, including the empty subset, which is why a word that found nothing also answers
 * every longer word built from it without another scan.
 */
export function memoizedProjectSearch(
    memo: ReadonlyMap<string, ProjectSearchMatch[]>,
    filter: string,
): ProjectSearchMatch[] | undefined {
    const needle = filter.toLocaleLowerCase();
    for (const [scanned, matches] of memo) {
        if (!needle.includes(scanned)) continue;
        return matches.filter((match) => match.relativePath.toLocaleLowerCase().includes(needle));
    }
    return undefined;
}

/**
 * Stores a complete scan so later filters can refine it locally. Never call this for a truncated or canceled scan: its
 * hits are not a superset of anything, so refining them would invent an authoritative answer the Project never gave.
 */
export function rememberProjectSearch(
    memo: Map<string, ProjectSearchMatch[]>,
    filter: string,
    matches: readonly ProjectSearchMatch[],
): void {
    if (memo.size >= MAX_SEARCH_MEMO_ENTRIES) {
        const oldest = memo.keys().next();
        if (!oldest.done) memo.delete(oldest.value);
    }
    memo.set(filter.toLocaleLowerCase(), [...matches]);
}

/**
 * Server Core returns name-mode hits in path order because the Search view lists them that way. Quick-open needs
 * relevance instead, so the strongest signal is how the file name itself matched; a hit that only matched a directory
 * segment ranks below every name hit.
 */
function nameScore(name: string, query: string): number {
    const candidate = name.toLocaleLowerCase();
    const needle = query.toLocaleLowerCase();
    if (!needle || !candidate.includes(needle)) return 0;
    if (candidate === needle) return 4;
    const extension = posix.extname(candidate);
    if (extension && candidate.slice(0, -extension.length) === needle) return 3;
    if (candidate.startsWith(needle)) return 2;
    return 1;
}

/**
 * Orders name-mode search hits for quick open and caps them at the snapshot's entry budget.
 *
 * Ties break toward the shallower path, then the shorter name, then a stable path comparison, so repeating the same
 * query cannot reshuffle the list under the user's selection.
 */
export function rankProjectSearchMatches(
    matches: readonly ProjectSearchMatch[],
    query: string,
    limit: number,
): RankedProjectMatch[] {
    const ranked = matches.map((match) => {
        const name = posix.basename(match.relativePath);
        const directoryLabel = posix.dirname(match.relativePath);
        return {
            directoryLabel: directoryLabel === '.' ? '' : directoryLabel,
            depth: match.relativePath.split('/').length,
            name,
            path: match.path,
            relativePath: match.relativePath,
            score: nameScore(name, query),
        };
    });
    return ranked
        .toSorted(
            (left, right) =>
                right.score - left.score ||
                left.depth - right.depth ||
                left.name.length - right.name.length ||
                left.relativePath.localeCompare(right.relativePath),
        )
        .slice(0, limit)
        .map(({ directoryLabel, name, path, relativePath }) => ({
            directoryLabel,
            name,
            path,
            relativePath,
        }));
}
