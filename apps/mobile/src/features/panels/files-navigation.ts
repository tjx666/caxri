import type { FileEntry } from '@caxri/protocol';

import { createSessionViewStore } from '../../lib/session-view-store';

/**
 * An edit in progress on the previewed file. `baseHash` is the content hash the edit started from (the write is refused
 * if the file moved on), and `original` is the text it started from, so an untouched editor is not "dirty".
 */
export interface FilesDraft {
    baseHash: string;
    content: string;
    original: string;
}

/**
 * Where the Files view stands in one Session: the open folders, the previewed file, and its draft. It lives in
 * {@link filesNavigationStore} so it survives the tab switch and the Android Back that unmount the view.
 */
export interface FilesNavigation {
    draft: FilesDraft | null;
    preview: FileEntry | null;
    stack: FileEntry[];
}

export const EMPTY_FILES_NAVIGATION: FilesNavigation = { draft: null, preview: null, stack: [] };

export const filesNavigationStore = createSessionViewStore(EMPTY_FILES_NAVIGATION);

const isEmpty = (navigation: FilesNavigation): boolean =>
    navigation.draft === null && navigation.preview === null && navigation.stack.length === 0;

/**
 * Normalizes to the shared empty value so the store drops the entry.
 */
const settle = (navigation: FilesNavigation): FilesNavigation =>
    isEmpty(navigation) ? EMPTY_FILES_NAVIGATION : navigation;

export const startDraft = (
    navigation: FilesNavigation,
    document: { content: string; contentHash: string },
): FilesNavigation => ({
    ...navigation,
    draft: {
        baseHash: document.contentHash,
        content: document.content,
        original: document.content,
    },
});

export const editDraft = (navigation: FilesNavigation, content: string): FilesNavigation =>
    navigation.draft ? { ...navigation, draft: { ...navigation.draft, content } } : navigation;

export const discardDraft = (navigation: FilesNavigation): FilesNavigation =>
    settle({ ...navigation, draft: null });

export const isDraftDirty = (draft: FilesDraft | null): boolean =>
    draft !== null && draft.content !== draft.original;

/**
 * Closes the preview (dropping its draft), optionally keeping only the first `depth` folders for a breadcrumb pick.
 */
export const closePreview = (navigation: FilesNavigation, depth?: number): FilesNavigation =>
    settle({
        draft: null,
        preview: null,
        stack: depth === undefined ? navigation.stack : navigation.stack.slice(0, depth),
    });

export const keepFolders = (navigation: FilesNavigation, depth: number): FilesNavigation =>
    settle({ ...navigation, stack: navigation.stack.slice(0, depth) });

/**
 * What hardware Back does next, walking out one level at a time: an open editor (a dirty one asks first), then the
 * preview, then each folder. `unhandled` at the Project root lets the screen go back.
 */
export type FilesBackStep =
    { kind: 'confirm-discard' } | { kind: 'move'; next: FilesNavigation } | { kind: 'unhandled' };

export const stepBack = (navigation: FilesNavigation): FilesBackStep => {
    if (navigation.draft !== null)
        return isDraftDirty(navigation.draft)
            ? { kind: 'confirm-discard' }
            : { kind: 'move', next: discardDraft(navigation) };
    if (navigation.preview !== null) return { kind: 'move', next: closePreview(navigation) };
    if (navigation.stack.length > 0)
        return { kind: 'move', next: keepFolders(navigation, navigation.stack.length - 1) };
    return { kind: 'unhandled' };
};
