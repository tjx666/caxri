import type { MethodResult } from '@caxri/protocol';

import type { PathBrowserCreateCandidate } from './path-browser';

type PathBrowserSnapshot = MethodResult<'pathBrowser.start'>;
export type PathBrowserEntry = PathBrowserSnapshot['entries'][number];
export type PathBrowserSearchStatus = PathBrowserSnapshot['projectSearch'];

/**
 * One line of the dialog. Creation shares the list and the selection model with the results so a single Enter path
 * serves both, instead of living in a separate slot the keyboard cannot reach. Headings and notices share the list for
 * the opposite reason: they describe where the rows beneath them came from, so they have to sit with those rows rather
 * than in chrome that scrolls separately.
 */
export type PathBrowserRow =
    | { candidate: PathBrowserCreateCandidate; kind: 'create' }
    /**
     * `group` repeats the heading above the row because a heading inside a listbox is never read: the keyboard moves
     * through options by `aria-activedescendant`, which skips everything that is not one. The row carries its own group
     * so the accessible name can say it, the way VS Code folds a Quick Pick separator into its entries.
     */
    | { entry: PathBrowserEntry; group?: string; kind: 'entry' }
    | { id: string; kind: 'group'; label: string }
    | { id: string; kind: 'notice'; text: string; tone: 'muted' | 'danger' };

/**
 * Headings and notices are read, not chosen. Arrow keys and the mouse both step over them, so the selected row is
 * always something Enter can act on.
 */
export function isSelectablePathBrowserRow(row: PathBrowserRow): boolean {
    return row.kind === 'create' || row.kind === 'entry';
}

/**
 * The next selectable row in `delta` direction, wrapping at both ends. Returns the current index when nothing in the
 * list can be selected, so a list of pure headings cannot spin forever.
 */
export function nextSelectablePathBrowserIndex(
    rows: readonly PathBrowserRow[],
    from: number,
    delta: -1 | 1,
): number {
    if (rows.length === 0) return 0;
    for (let step = 1; step <= rows.length; step += 1) {
        const index = (((from + delta * step) % rows.length) + rows.length) % rows.length;
        const row = rows.at(index);
        if (row && isSelectablePathBrowserRow(row)) return index;
    }
    return from;
}

/**
 * The first selectable row, used whenever the list is rebuilt and the previous position no longer means anything.
 */
export function firstSelectablePathBrowserIndex(rows: readonly PathBrowserRow[]): number {
    const index = rows.findIndex((row) => isSelectablePathBrowserRow(row));
    return index === -1 ? 0 : index;
}

const DIRECTORY_GROUP_LABEL = 'In this folder';
const PROJECT_GROUP_LABEL = 'Elsewhere in this Project';

/**
 * Says the search could not run, rather than letting its group disappear. A missing group and an empty group read the
 * same way: "this name is nowhere else", and only one of them is true.
 */
const SEARCH_UNAVAILABLE_NOTICE = 'Project search is unavailable right now.';
const SEARCH_INCOMPLETE_NOTICE = 'Only part of this Project was searched. Refine the name.';
const DIRECTORY_TRUNCATED_NOTICE =
    'Only part of this folder is shown. Refine or open a narrower folder.';
const NO_MATCH_NOTICE = 'No matching file or folder.';

/**
 * Builds the dialog's list from both lookups at once.
 *
 * Every source that was asked for gets a heading and stays visible, including one that found nothing: hiding a source
 * behind another source's emptiness is what made the Project-wide search unreachable in practice (issue #986). The
 * create row is independent of all of it: it is an action the user can see and point at, never a stand-in for a search
 * that failed.
 */
export function pathBrowserRows(input: {
    candidateToCreate: PathBrowserCreateCandidate | undefined;
    entries: readonly PathBrowserEntry[];
    isDirectoryTruncated: boolean;
    /**
     * Empty input lists the directory rather than searching it, so there is nothing to have failed to match and no
     * placeholder to show.
     */
    query: string;
    searchStatus: PathBrowserSearchStatus;
}): PathBrowserRow[] {
    const { candidateToCreate, entries, isDirectoryTruncated, query, searchStatus } = input;
    const listed = entries.filter((entry) => entry.source === 'directory');
    const found = entries.filter((entry) => entry.source === 'projectSearch');
    const isSearching = searchStatus !== 'skipped';
    const rows: PathBrowserRow[] = [];

    if (isSearching)
        rows.push({ id: 'group-directory', kind: 'group', label: DIRECTORY_GROUP_LABEL });
    for (const entry of listed)
        rows.push({ entry, ...(isSearching && { group: DIRECTORY_GROUP_LABEL }), kind: 'entry' });
    if (isSearching && listed.length === 0)
        rows.push({
            id: 'notice-directory-empty',
            kind: 'notice',
            text: NO_MATCH_NOTICE,
            tone: 'muted',
        });
    // Truncation belongs to the rows it cut off, in both modes, which is why it sits here rather than in a footer: a
    // note under the whole dialog could not say which of the two groups was the incomplete one.
    if (isDirectoryTruncated && listed.length > 0)
        rows.push({
            id: 'notice-directory-truncated',
            kind: 'notice',
            text: DIRECTORY_TRUNCATED_NOTICE,
            tone: 'muted',
        });

    if (isSearching) {
        rows.push({ id: 'group-project', kind: 'group', label: PROJECT_GROUP_LABEL });
        for (const entry of found) rows.push({ entry, group: PROJECT_GROUP_LABEL, kind: 'entry' });
        if (searchStatus === 'unavailable')
            rows.push({
                id: 'notice-search-unavailable',
                kind: 'notice',
                text: SEARCH_UNAVAILABLE_NOTICE,
                tone: 'danger',
            });
        else if (found.length === 0)
            rows.push({
                id: 'notice-search-empty',
                kind: 'notice',
                text: NO_MATCH_NOTICE,
                tone: 'muted',
            });
        if (searchStatus === 'incomplete')
            rows.push({
                id: 'notice-search-incomplete',
                kind: 'notice',
                text: SEARCH_INCOMPLETE_NOTICE,
                tone: 'muted',
            });
    } else if (listed.length === 0 && query.length > 0) {
        rows.push({
            id: 'notice-directory-empty',
            kind: 'notice',
            text: NO_MATCH_NOTICE,
            tone: 'muted',
        });
    }

    if (candidateToCreate) rows.push({ candidate: candidateToCreate, kind: 'create' });
    return rows;
}
