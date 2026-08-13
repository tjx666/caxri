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

export interface PathBrowserCreateCandidate {
    kind: 'directory' | 'file';
    name: string;
}

/**
 * The `bodil/vscode-file-browser` signature affordance: once filtering proves nothing in the
 * current directory matches, typing a name offers to create it — a trailing `/` is the folder
 * signal (matching Tab-completion's own directory-suffix convention). Only offered on an
 * authoritative empty result: a truncated scan might still contain a match Caxri never fetched, so
 * offering to create there could shadow an existing file instead of genuinely making a new one.
 */
export function pathBrowserCreateCandidate(
    query: string,
    matchCount: number,
    truncated: boolean,
): PathBrowserCreateCandidate | undefined {
    if (matchCount > 0 || truncated || !query) return undefined;
    const kind: PathBrowserCreateCandidate['kind'] = query.endsWith('/') ? 'directory' : 'file';
    const name = kind === 'directory' ? query.slice(0, -1) : query;
    if (!name || name === '.' || name === '..' || name.includes('/')) return undefined;
    return { kind, name };
}

/** Returns one POSIX-style parent while keeping malformed or stale paths pinned to Project root. */
export function parentDirectoryWithinRoot(root: string, directory: string): string {
    const withinRoot = root === '/' ? directory.startsWith('/') : pathIsAtOrBelow(directory, root);
    if (directory === root || !withinRoot) return root;
    const separator = directory.lastIndexOf('/');
    const parent = separator > 0 ? directory.slice(0, separator) : root;
    return root === '/' || pathIsAtOrBelow(parent, root) ? parent : root;
}
