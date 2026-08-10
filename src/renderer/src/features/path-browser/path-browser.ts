import type { FileEntry } from '@shared/types';

import { pathIsAtOrBelow } from '../../lib/file-path';

/** Filters the already-lazy current-directory result; it never starts a Project-wide traversal. */
export function filterPathEntries(entries: readonly FileEntry[], query: string): FileEntry[] {
    const needle = query.toLocaleLowerCase();
    if (!needle) return [...entries];
    return entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle));
}

/** Tab completion is deliberately deterministic: ambiguous matches leave the user's text intact. */
export function completePathQuery(
    entries: readonly FileEntry[],
    query: string,
    truncated = false,
): string | undefined {
    if (truncated) return undefined;
    const matches = filterPathEntries(entries, query);
    return matches.length === 1 ? matches[0].name : undefined;
}

/** Keeps an exhausted scan distinct from an authoritative empty directory result. */
export function pathBrowserEmptyMessage(
    matchCount: number,
    truncated: boolean,
): string | undefined {
    if (matchCount > 0) return;
    return truncated
        ? 'No match in the scanned items. Refine or open a narrower folder.'
        : 'No matching file or folder.';
}

/** Returns one POSIX-style parent while keeping malformed or stale paths pinned to Project root. */
export function parentDirectoryWithinRoot(root: string, directory: string): string {
    if (directory === root || !pathIsAtOrBelow(directory, root)) return root;
    const separator = directory.lastIndexOf('/');
    const parent = separator > 0 ? directory.slice(0, separator) : root;
    return pathIsAtOrBelow(parent, root) ? parent : root;
}
