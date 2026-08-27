import { isPathAtOrBelow } from '../../lib/file-path';

export interface PathBrowserInput {
    kind: 'absolute' | 'filter' | 'home' | 'parent' | 'relative';
    value: string;
}

/**
 * Classifies path syntax without expanding it in the sandboxed Renderer. Electron Main repeats this validation before
 * resolving Home or touching the filesystem; this helper only decides whether Enter means filter/open or navigation.
 */
export function parsePathBrowserInput(value: string): PathBrowserInput {
    if (/^\$(?:HOME|\{HOME\})(?:\/|$)/u.test(value))
        throw new Error('Shell path expansion is not supported');
    if (value.startsWith('~') && !value.startsWith('~/'))
        throw new Error('Only current-user ~/ paths are supported');
    if (value.startsWith('~/')) return { kind: 'home', value };
    if (value.startsWith('/')) return { kind: 'absolute', value };
    if (value === '..' || value.startsWith('../')) return { kind: 'parent', value };
    if (value.includes('/')) return { kind: 'relative', value };
    return { kind: 'filter', value };
}

/**
 * Filters the already-lazy current-directory result; it never starts a Project-wide traversal.
 */
export function filterPathEntries<T extends { name: string }>(
    entries: readonly T[],
    query: string,
): T[] {
    const needle = query.toLocaleLowerCase();
    if (!needle) return [...entries];
    return entries.filter((entry) => entry.name.toLocaleLowerCase().includes(needle));
}

/**
 * Tab completion is deliberately deterministic: ambiguous matches leave the user's text intact.
 */
export function completePathQuery(
    entries: ReadonlyArray<{ name: string }>,
    query: string,
    isTruncated = false,
): string | undefined {
    if (isTruncated) return undefined;
    const matches = filterPathEntries(entries, query);
    return matches.length === 1 ? matches[0].name : undefined;
}

/**
 * Keeps an exhausted scan distinct from an authoritative empty directory result.
 */
export function pathBrowserEmptyMessage(
    matchCount: number,
    isTruncated: boolean,
): string | undefined {
    if (matchCount > 0) return;
    return isTruncated
        ? 'No match in the scanned items. Refine or open a narrower folder.'
        : 'No matching file or folder.';
}

export interface PathBrowserCreateCandidate {
    kind: 'directory' | 'file';
    name: string;
}

/**
 * The `bodil/vscode-file-browser` signature affordance: once filtering proves nothing in the current directory matches,
 * typing a name offers to create it — a trailing `/` is the folder signal (matching Tab-completion's own
 * directory-suffix convention). Only offered on an authoritative empty result: a truncated scan might still contain a
 * match Caxri never fetched, and a debounced query can temporarily expose zero matches before its result is ready.
 * Offering to create in either state could shadow an existing file instead of genuinely making a new one.
 */
export function pathBrowserCreateCandidate(
    query: string,
    matchCount: number,
    isTruncated: boolean,
    isResultsReady: boolean,
): PathBrowserCreateCandidate | undefined {
    if (!isResultsReady || isTruncated || !query || matchCount > 0) return undefined;
    const kind: PathBrowserCreateCandidate['kind'] = query.endsWith('/') ? 'directory' : 'file';
    const name = kind === 'directory' ? query.slice(0, -1) : query;
    if (!name || name === '.' || name === '..' || name.includes('/')) return undefined;
    return { kind, name };
}

/**
 * Returns one POSIX-style parent while keeping malformed or stale paths pinned to Project root.
 */
export function parentDirectoryWithinRoot(root: string, directory: string): string {
    const isWithinRoot =
        root === '/' ? directory.startsWith('/') : isPathAtOrBelow(directory, root);
    if (directory === root || !isWithinRoot) return root;
    const separator = directory.lastIndexOf('/');
    const parent = separator > 0 ? directory.slice(0, separator) : root;
    return root === '/' || isPathAtOrBelow(parent, root) ? parent : root;
}
