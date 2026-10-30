import { posix } from 'node:path';

import { rankPathMatches } from '@caxri/utils';

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
    return rankPathMatches(matches, (match) => match.relativePath, query, limit).map((match) => {
        const directoryLabel = posix.dirname(match.relativePath);
        return {
            directoryLabel: directoryLabel === '.' ? '' : directoryLabel,
            name: posix.basename(match.relativePath),
            path: match.path,
            relativePath: match.relativePath,
        };
    });
}
