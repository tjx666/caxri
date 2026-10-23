import { isPathAtOrBelow, isVirtualEditorTabPath } from '@caxri/protocol';

/**
 * Files recently opened as editor tabs, newest first, for the `Cmd+P` path browser. It follows VS Code's editor
 * history, which Quick Open lists under "recently opened": a file moves to the front each time it is opened, and the
 * oldest entries fall off a fixed bound (VS Code keeps 200).
 *
 * Only Project files are kept. A history entry is an absolute path that the Renderer can only hand back to the same
 * `files.read` route a Files-tree click uses, which Server Core authorizes against the Session's Project root. External
 * documents have no such route: their authority is a Main-issued `documentId` that dies with the process
 * (docs/adr/0013-editable-external-documents.md), so they are never recorded.
 */
export const MAX_RECENT_FILES = 200;

/**
 * Whether `path` is a regular Project file that may enter the history: not a virtual tab (Settings, diffs, untitled
 * buffers) and not the Project root itself or anything outside it.
 */
export function isRecordableRecentFile(root: string, path: string): boolean {
    return !isVirtualEditorTabPath(path) && path !== root && isPathAtOrBelow(path, root);
}

/**
 * Moves `path` to the front of `paths`, dropping any earlier copy and the entries beyond the bound.
 */
export function recordRecentFile(paths: readonly string[], path: string): string[] {
    if (paths[0] === path) return [...paths];
    return [path, ...paths.filter((existing) => existing !== path)].slice(0, MAX_RECENT_FILES);
}

/**
 * Reads a stored value back, keeping only non-empty strings. A corrupt or foreign value reads as an empty history
 * instead of failing the dialog.
 */
export function parseRecentFiles(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    for (const item of value) if (typeof item === 'string' && item.length > 0) seen.add(item);
    return [...seen].slice(0, MAX_RECENT_FILES);
}

/**
 * Removes `path` after it proved to be gone, so a deleted file stops reappearing in the list.
 */
export function forgetRecentFile(paths: readonly string[], path: string): string[] {
    return paths.filter((existing) => existing !== path);
}

export interface RecentFileMatch {
    /**
     * Absolute path, what `files.read` takes.
     */
    path: string;
    /**
     * File name, the row's label.
     */
    name: string;
    /**
     * Project-relative directory without a trailing slash, empty at the root; the row's muted description.
     */
    directoryLabel: string;
}

/**
 * Lower is better; `undefined` means the name does not match. Matching is case-insensitive and on the file name only,
 * as VS Code matches history entries on the label unless the query has a path separator (this list is only used for
 * queries without one).
 */
function nameRank(name: string, query: string): number | undefined {
    if (query === '') return 0;
    const lowerName = name.toLowerCase();
    if (lowerName.startsWith(query)) return 0;
    if (lowerName.includes(query)) return 1;
    let from = 0;
    for (const character of query) {
        const found = lowerName.indexOf(character, from);
        if (found === -1) return undefined;
        from = found + 1;
    }
    return 2;
}

/**
 * The recent files to list for `filter`, ready for rows.
 *
 * Without a filter every entry is returned in recency order. With one, entries are kept when their name matches and
 * ordered by match quality, then by recency (VS Code's default `historyFilterSortOrder` sorts history by fuzzy score).
 * `excludePath` is the file already showing in the active tab: VS Code lists the active editor first, which makes Enter
 * a no-op, so it is left out here.
 */
export function matchRecentFiles(input: {
    excludePath?: string;
    filter: string;
    paths: readonly string[];
    root: string;
}): RecentFileMatch[] {
    const { excludePath, filter, paths, root } = input;
    const query = filter.toLowerCase();
    const prefix = root === '/' ? '/' : `${root}/`;
    const ranked: Array<{ index: number; match: RecentFileMatch; rank: number }> = [];
    for (const [index, path] of paths.entries()) {
        if (path === excludePath || !isRecordableRecentFile(root, path)) continue;
        const relative = path.slice(prefix.length);
        const separator = relative.lastIndexOf('/');
        const name = relative.slice(separator + 1);
        const rank = nameRank(name, query);
        if (rank === undefined) continue;
        ranked.push({
            index,
            match: {
                directoryLabel: separator === -1 ? '' : relative.slice(0, separator),
                name,
                path,
            },
            rank,
        });
    }
    ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
    return ranked.map(({ match }) => match);
}
