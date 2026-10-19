import { parsePathBrowserInput, pathBrowserKeyIntent } from '../path-browser/path-browser';

/**
 * Path helpers for the SSH Host folder picker. The listed folders live on a Linux SSH Host, so every path here is a
 * POSIX path regardless of the Mac's own conventions.
 */

export interface FolderBreadcrumb {
    label: string;
    path: string;
}

function trimTrailingSlashes(path: string): string {
    const trimmed = path.replace(/\/+$/u, '');
    return trimmed === '' ? '/' : trimmed;
}

/**
 * Resolves what the user typed into an absolute path: `~` and `~/…` expand against the SSH Host's home folder, an
 * absolute path is kept, and anything else (a relative path, `~user`) is refused because there is no current folder the
 * user would agree it is relative to.
 */
export function resolveFolderInput(input: string, home: string): string | undefined {
    const value = input.trim();
    if (value === '~') return trimTrailingSlashes(home);
    if (value.startsWith('~/'))
        return trimTrailingSlashes(`${trimTrailingSlashes(home)}/${value.slice(2)}`);
    if (value.startsWith('/')) return trimTrailingSlashes(value.replaceAll(/\/{2,}/gu, '/'));
    return undefined;
}

/**
 * Splits an absolute folder into clickable ancestors. Inside the home folder the trail starts at `~`, which is both
 * shorter and how the user already thinks of those paths; elsewhere it starts at `/`.
 */
export function folderBreadcrumbs(path: string, home: string): FolderBreadcrumb[] {
    const normalizedHome = trimTrailingSlashes(home);
    const normalizedPath = trimTrailingSlashes(path);
    const isUnderHome =
        normalizedHome !== '/' &&
        (normalizedPath === normalizedHome || normalizedPath.startsWith(`${normalizedHome}/`));
    const root: FolderBreadcrumb = isUnderHome
        ? { label: '~', path: normalizedHome }
        : { label: '/', path: '/' };
    const rest = isUnderHome
        ? normalizedPath.slice(normalizedHome.length)
        : normalizedPath === '/'
          ? ''
          : normalizedPath;
    const crumbs = [root];
    let current = root.path === '/' ? '' : root.path;
    for (const segment of rest.split('/')) {
        if (!segment) continue;
        current += `/${segment}`;
        crumbs.push({ label: segment, path: current });
    }
    return crumbs;
}

/**
 * The path as the input field shows it: `~`-relative inside the home folder.
 */
export function displayFolderPath(path: string, home: string): string {
    const crumbs = folderBreadcrumbs(path, home);
    if (crumbs[0]?.label !== '~') return trimTrailingSlashes(path);
    return ['~', ...crumbs.slice(1).map((crumb) => crumb.label)].join('/');
}

/**
 * The folder field's text for a folder nobody has typed over: the path with a trailing slash, so what the user types
 * next is the name filter of that folder, as in Open File by Path.
 */
export function folderInputText(path: string, home: string): string {
    const display = displayFolderPath(path, home);
    return display.endsWith('/') ? display : `${display}/`;
}

export interface FolderInputView {
    /**
     * The folder the typed text names before its last segment, or undefined when the text names none (no slash yet, a
     * relative path, a refused form) and the listing stays where it is.
     */
    directory: string | undefined;
    /**
     * The last segment, which narrows that folder's subfolders.
     */
    filter: string;
}

/**
 * Splits the typed text with Path browser's parser: everything up to the last slash is the folder to list, the rest
 * filters it. Text the parser refuses (`$HOME`, `~user`) filters nothing.
 */
export function folderInputView(input: string, home: string): FolderInputView {
    try {
        const parsed = parsePathBrowserInput(input);
        const directory =
            parsed.kind === 'absolute' || parsed.kind === 'home'
                ? resolveFolderInput(parsed.directoryPart, home)
                : undefined;
        return { directory, filter: parsed.filter };
    } catch {
        return { directory: undefined, filter: '' };
    }
}

/**
 * The row Enter, Tab, and the right arrow act on: the one the arrow keys chose, otherwise, once a filter is typed, the
 * folder named exactly like it or else the first match. An empty filter has no target, so Enter keeps meaning "go to
 * the typed path".
 */
export function folderTargetIndex(
    entries: ReadonlyArray<{ name: string }>,
    filter: string,
    selectedIndex: number | undefined,
): number | undefined {
    if (entries.length === 0) return undefined;
    if (selectedIndex !== undefined) return Math.min(selectedIndex, entries.length - 1);
    if (!filter) return undefined;
    const exact = entries.findIndex((entry) => entry.name === filter);
    return exact === -1 ? 0 : exact;
}

/**
 * Moves the chosen row one step, wrapping at both ends. With nothing chosen yet, Down starts at the first row and Up at
 * the last.
 */
export function moveFolderSelection(
    count: number,
    selectedIndex: number | undefined,
    delta: -1 | 1,
): number {
    if (selectedIndex === undefined) return delta === 1 ? 0 : count - 1;
    return (selectedIndex + delta + count) % count;
}

export type FolderKeyAction =
    | { delta: -1 | 1; kind: 'move' }
    | { kind: 'complete' }
    | { kind: 'open-target' }
    | { kind: 'parent' }
    | { kind: 'submit-path' };

/**
 * Maps a key in the folder field to a picker action through Path browser's key table, so both browsers read the arrows,
 * Tab, and Enter the same way. Escape is left to the dialog, and there is no free mode to detach into.
 */
export function folderKeyAction(
    context: Omit<
        Parameters<typeof pathBrowserKeyIntent>[0],
        'canBrowseFree' | 'mode' | 'selectedKind'
    > & {
        hasTarget: boolean;
    },
): FolderKeyAction | undefined {
    const { hasTarget, ...keyContext } = context;
    const intent = pathBrowserKeyIntent({
        ...keyContext,
        canBrowseFree: false,
        mode: 'project',
        selectedKind: hasTarget ? 'directory' : undefined,
    });
    switch (intent?.kind) {
        case 'move-selection': {
            return { delta: intent.delta, kind: 'move' };
        }
        case 'complete': {
            return hasTarget ? { kind: 'complete' } : undefined;
        }
        case 'enter-directory': {
            return { kind: 'open-target' };
        }
        case 'parent': {
            return { kind: 'parent' };
        }
        case 'accept': {
            return hasTarget ? { kind: 'open-target' } : { kind: 'submit-path' };
        }
        default: {
            return undefined;
        }
    }
}
