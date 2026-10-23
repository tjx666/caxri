import type { MethodResult } from '@caxri/protocol';

import type { TranslationKey } from '../../i18n';
import type { RecentFileMatch } from '../editor/recent-files';
import type { PathBrowserCreateCandidate } from './path-browser';

type PathBrowserSnapshot = MethodResult<'pathBrowser.start'>;
export type PathBrowserEntry = PathBrowserSnapshot['entries'][number];
export type PathBrowserSearchStatus = PathBrowserSnapshot['projectSearch'];

/**
 * One line of the dialog. Group labels and notice texts are translation keys, so the dialog renders them in the active
 * language at render time. Creation shares the list and the selection model with the results so a single Enter path
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
    | { entry: PathBrowserEntry; group?: TranslationKey; kind: 'entry' }
    | { id: string; kind: 'group'; label: TranslationKey }
    /**
     * A file from the recent-files history. It is not a Main-issued entry: choosing it reopens `file.path` through the
     * same Session-authorized read a Files-tree click uses. `group` repeats the heading for the same reason as above.
     */
    | { file: RecentFileMatch; group: TranslationKey; kind: 'recent' }
    | { id: string; kind: 'notice'; text: TranslationKey; tone: 'muted' | 'danger' };

const SELECTABLE_ROW_KINDS: ReadonlySet<PathBrowserRow['kind']> = new Set([
    'create',
    'entry',
    'recent',
]);

/**
 * Headings and notices are read, not chosen. Arrow keys and the mouse both step over them, so the selected row is
 * always something Enter can act on.
 */
export function isSelectablePathBrowserRow(row: PathBrowserRow): boolean {
    return SELECTABLE_ROW_KINDS.has(row.kind);
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

/**
 * `directoryLabel` values are Project-relative with or without slashes at the ends; the recent-files model uses none.
 */
function normalizedDirectory(label: string): string {
    return label.replaceAll(/^\/+|\/+$/gu, '');
}

function relativeFilePath(directory: string, name: string): string {
    return directory ? `${directory}/${name}` : name;
}

const DIRECTORY_GROUP_LABEL: TranslationKey = 'pathBrowser.rows.directoryGroup';
const PROJECT_GROUP_LABEL: TranslationKey = 'pathBrowser.rows.projectGroup';
const RECENT_GROUP_LABEL: TranslationKey = 'pathBrowser.rows.recentGroup';

/**
 * Says the search could not run, rather than letting its group disappear. A missing group and an empty group read the
 * same way: "this name is nowhere else", and only one of them is true.
 */
const SEARCH_UNAVAILABLE_NOTICE: TranslationKey = 'pathBrowser.rows.searchUnavailable';
const SEARCH_INCOMPLETE_NOTICE: TranslationKey = 'pathBrowser.rows.searchIncomplete';
const DIRECTORY_TRUNCATED_NOTICE: TranslationKey = 'pathBrowser.rows.directoryTruncated';
const NO_MATCH_NOTICE: TranslationKey = 'pathBrowser.rows.noMatch';

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
    /**
     * Project-relative directory the listing shows, to tell which listed rows are already in `recent`.
     */
    directoryLabel?: string;
    entries: readonly PathBrowserEntry[];
    isDirectoryTruncated: boolean;
    /**
     * Empty input lists the directory rather than searching it, so there is nothing to have failed to match and no
     * placeholder to show.
     */
    query: string;
    /**
     * Recent files that match the query, newest or best first. They lead the list, and a row that repeats one of them
     * is left out of the groups below so a file never appears twice.
     */
    recent?: readonly RecentFileMatch[];
    searchStatus: PathBrowserSearchStatus;
}): PathBrowserRow[] {
    const {
        candidateToCreate,
        directoryLabel = '',
        entries,
        isDirectoryTruncated,
        query,
        recent = [],
        searchStatus,
    } = input;
    const listed = entries.filter((entry) => entry.source === 'directory');
    const found = entries.filter((entry) => entry.source === 'projectSearch');
    const isSearching = searchStatus !== 'skipped';
    const rows: PathBrowserRow[] = [];

    if (recent.length > 0) {
        rows.push({ id: 'group-recent', kind: 'group', label: RECENT_GROUP_LABEL });
        for (const file of recent) rows.push({ file, group: RECENT_GROUP_LABEL, kind: 'recent' });
    }
    const recentPaths = new Set(
        recent.map((file) => relativeFilePath(file.directoryLabel, file.name)),
    );
    const isRecent = (entry: PathBrowserEntry, directory: string): boolean =>
        entry.kind === 'file' && recentPaths.has(relativeFilePath(directory, entry.name));
    const visibleListed = listed.filter(
        (entry) => !isRecent(entry, normalizedDirectory(directoryLabel)),
    );
    const visibleFound = found.filter(
        (entry) => !isRecent(entry, normalizedDirectory(entry.directoryLabel ?? '')),
    );
    // A group whose rows were all moved into the recent group has nothing to say, so it is dropped rather than shown
    // empty or mislabelled "No matching file".
    const isListedHidden = listed.length > 0 && visibleListed.length === 0;
    const isFoundHidden = found.length > 0 && visibleFound.length === 0;

    if (isSearching && !isListedHidden)
        rows.push({ id: 'group-directory', kind: 'group', label: DIRECTORY_GROUP_LABEL });
    for (const entry of visibleListed)
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
        if (!isFoundHidden)
            rows.push({ id: 'group-project', kind: 'group', label: PROJECT_GROUP_LABEL });
        for (const entry of visibleFound)
            rows.push({ entry, group: PROJECT_GROUP_LABEL, kind: 'entry' });
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
    } else if (listed.length === 0 && recent.length === 0 && query.length > 0) {
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
