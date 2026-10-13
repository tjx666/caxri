import { isPathAtOrBelow } from '@caxri/protocol';
import type { PathBrowserDenialReason } from '@desktop-shared/path-browser-denial';
import { pathBrowserDenialReason } from '@desktop-shared/path-browser-denial';

import type { TranslationKey } from '../../i18n';
import { translate } from '../../i18n';
import { isDirectoryEntry } from '../../lib/file-entry';
import { describeFailure } from '../../stores/toasts';

export type PathBrowserMode = 'free' | 'project';

export interface PathBrowserInputState {
    input: string;
    mode: PathBrowserMode;
}

export interface ParsedPathBrowserInput {
    directoryPart: string;
    filter: string;
    hasTrailingSlash: boolean;
    kind: 'absolute' | 'filter' | 'home' | 'parent' | 'relative';
    value: string;
}

/**
 * A typed input the browser refuses before asking Main. Carries its translation key so the dialog can render the
 * message in the active language; `message` is a snapshot for callers that only read it as an `Error`.
 */
export class PathBrowserInputError extends Error {
    constructor(readonly messageKey: TranslationKey) {
        super(translate(messageKey));
        this.name = 'PathBrowserInputError';
    }
}

const sshHostDenialKeys = {
    homeUnavailable: 'sshHost.pathBrowser.homeUnavailable',
    outsideProjectRoot: 'sshHost.pathBrowser.outsideProject',
} as const satisfies Record<PathBrowserDenialReason, TranslationKey>;

/**
 * Plain copy for a path Main refused because an SSH Host window's browser covers its Project only, in place of Main's
 * English message. A local window can browse outside its Project, so its refusals keep the generic failure text.
 */
export function pathBrowserDenialMessageKey(
    error: unknown,
    isSshHost: boolean,
): TranslationKey | undefined {
    if (!isSshHost) return undefined;
    const reason = pathBrowserDenialReason(error);
    return reason && sshHostDenialKeys[reason];
}

/**
 * The error the browser shows for a failed request: the plain {@link pathBrowserDenialMessageKey} copy for a refusal
 * that has one, otherwise the failure's own message or `fallback`.
 */
export function pathBrowserError(error: unknown, fallback: string, isSshHost: boolean): Error {
    const key = pathBrowserDenialMessageKey(error, isSshHost);
    return new Error(key ? translate(key) : describeFailure(error, fallback));
}

/**
 * Splits the user's POSIX-style path into a directory request and its final filter segment without resolving either in
 * the sandboxed Renderer. Electron Main repeats validation and owns canonical filesystem resolution.
 */
export function parsePathBrowserInput(value: string): ParsedPathBrowserInput {
    if (/^\$(?:HOME|\{HOME\})(?:\/|$)/u.test(value))
        throw new PathBrowserInputError('pathBrowser.errors.shellExpansion');
    if (value !== '~' && value.startsWith('~') && !value.startsWith('~/'))
        throw new PathBrowserInputError('pathBrowser.errors.otherUserHome');

    const hasTrailingSlash = value.endsWith('/');
    let kind: ParsedPathBrowserInput['kind'];
    if (value === '~' || value.startsWith('~/')) kind = 'home';
    else if (value.startsWith('/')) kind = 'absolute';
    else if (value === '..' || value.startsWith('../')) kind = 'parent';
    else if (value.includes('/')) kind = 'relative';
    else kind = 'filter';

    if (value === '~')
        return { directoryPart: '~/', filter: '', hasTrailingSlash: false, kind, value };
    if (value === '..')
        return { directoryPart: '../', filter: '', hasTrailingSlash: false, kind, value };

    const separator = value.lastIndexOf('/');
    if (separator === -1)
        return { directoryPart: '', filter: value, hasTrailingSlash, kind, value };
    return {
        directoryPart: value.slice(0, separator + 1),
        filter: value.slice(separator + 1),
        hasTrailingSlash,
        kind,
        value,
    };
}

/**
 * The Project anchor a typed or pasted input implies, and the input left once that anchor is applied.
 *
 * An absolute or `~` path cannot mean anything inside a Project: in Project mode it was rejected as an escape and fell
 * through to the subpath guess, so the only way to reach it was the Backspace gesture almost nobody finds. Typing one
 * now detaches by itself, which is what the user was already saying by typing it.
 *
 * `./` is the way back. It is consumed rather than sent, so the bare prefix restores the Project chrome with an empty
 * field and `./src` lands on `src` under the root. Nothing is lost by claiming it in free mode: a free-mode `./x` and a
 * bare `x` already resolved to the same entry of the current directory.
 *
 * An SSH Host window has no free mode (`canBrowseFree` false): an absolute path stays a Project path there, so one that
 * points inside the remote Project still opens.
 */
export function pathBrowserInputTransition(
    current: PathBrowserInputState,
    input: string,
    canBrowseFree = true,
): PathBrowserInputState {
    const isAbsoluteOrHome = input.startsWith('/') || input === '~' || input.startsWith('~/');
    if (canBrowseFree && isAbsoluteOrHome && current.mode === 'project')
        return { input, mode: 'free' };
    if (current.mode === 'free' && input.startsWith('./'))
        return { input: input.slice(2), mode: 'project' };
    return { input, mode: current.mode };
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
 * Completes only an authoritative unique result and preserves every path segment before the final filter.
 *
 * A `projectSearch` row names a file somewhere else in the Project, so completing the input with it would produce a
 * path relative to the current directory that does not exist. Callers pass the directory rows alone; the two lookups
 * now arrive in one list, so "one result" has to mean one result _here_.
 */
export function completePathQuery(
    entries: ReadonlyArray<{ kind?: string; linkKind?: string; name: string }>,
    input: string,
    isTruncated = false,
): string | undefined {
    if (isTruncated || entries.length !== 1) return undefined;
    const parsed = parsePathBrowserInput(input);
    const [entry] = entries;
    return `${parsed.directoryPart}${entry.name}${isDirectoryEntry(entry) ? '/' : ''}`;
}

export interface PathBrowserCreateCandidate {
    kind: 'directory' | 'file';
    name: string;
}

/**
 * Creation stays an explicitly Project-local capability. A free-path result may point anywhere readable by the current
 * macOS user, so it must never expose a write action even when its text happens to resolve inside a Project.
 *
 * `directoryMatchCount` counts only entries of the current directory, which is where creation happens. Project-search
 * rows live elsewhere and must not suppress the offer, or finding a same-named file in another folder would silently
 * remove the user's ability to create one here.
 */
export function pathBrowserCreateCandidate(
    mode: PathBrowserMode,
    query: string,
    directoryMatchCount: number,
    isTruncated: boolean,
    isResultsReady: boolean,
): PathBrowserCreateCandidate | undefined {
    if (mode !== 'project' || !isResultsReady || isTruncated || !query || directoryMatchCount > 0)
        return undefined;
    const kind: PathBrowserCreateCandidate['kind'] = query.endsWith('/') ? 'directory' : 'file';
    const name = kind === 'directory' ? query.slice(0, -1) : query;
    if (!name || name === '.' || name === '..' || name.includes('/')) return undefined;
    return { kind, name };
}

export type PathBrowserKeyIntent =
    | { kind: 'accept' }
    | { kind: 'close' }
    | { kind: 'complete' }
    | { kind: 'detach-project' }
    | { kind: 'enter-directory' }
    | { delta: -1 | 1; kind: 'move-selection' }
    | { kind: 'parent' };

interface PathBrowserKeyContext {
    /**
     * False in an SSH Host window, which has no free mode to detach into.
     */
    canBrowseFree?: boolean;
    entryCount: number;
    input: string;
    isComposing: boolean;
    key: string;
    mode: PathBrowserMode;
    selectedKind?: 'directory' | 'file' | 'symlink';
    selectionEnd: number | null;
    selectionStart: number | null;
}

/**
 * Maps input keys to browser commands while preserving ordinary caret movement whenever the cursor is inside text.
 */
export function pathBrowserKeyIntent({
    canBrowseFree = true,
    entryCount,
    input,
    isComposing,
    key,
    mode,
    selectedKind,
    selectionEnd,
    selectionStart,
}: PathBrowserKeyContext): PathBrowserKeyIntent | undefined {
    if (isComposing) return;
    if (key === 'Escape') return { kind: 'close' };
    const isCollapsed = selectionStart !== null && selectionStart === selectionEnd;
    if (
        canBrowseFree &&
        mode === 'project' &&
        input === '' &&
        isCollapsed &&
        selectionStart === 0 &&
        (key === 'Backspace' || key === 'Delete')
    )
        return { kind: 'detach-project' };
    if ((key === 'ArrowDown' || key === 'ArrowUp') && entryCount > 0)
        return { delta: key === 'ArrowDown' ? 1 : -1, kind: 'move-selection' };
    if (key === 'Tab') return { kind: 'complete' };
    if (
        key === 'ArrowRight' &&
        selectedKind === 'directory' &&
        isCollapsed &&
        selectionEnd === input.length
    )
        return { kind: 'enter-directory' };
    if (key === 'ArrowLeft' && isCollapsed && selectionStart === 0) return { kind: 'parent' };
    if (key === 'Enter') return { kind: 'accept' };
    return;
}

/**
 * Returns the absolute directory represented by Project chrome so detaching the anchor preserves the visible location.
 */
export function projectDirectoryPath(root: string, directoryLabel: string): string {
    const relativeDirectory = directoryLabel.replaceAll(/^\/+|\/+$/gu, '');
    const directory = relativeDirectory
        ? root === '/'
            ? `/${relativeDirectory}`
            : `${root}/${relativeDirectory}`
        : root;
    return directory === '/' ? '/' : `${directory}/`;
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
