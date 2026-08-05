import type { FileDocument, SessionState } from './types';

export interface EditorDocument extends FileDocument {
    dirty: boolean;
}

export type SessionDocuments = Record<string, Record<string, EditorDocument>>;

/** Monaco models are URI-keyed, so Session identity must be part of the URI even for a shared root. */
export function editorModelPath(sessionId: string, path: string): string {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    const encodedPath = normalizedPath.split('/').map(encodeURIComponent).join('/');
    return `caxri://session/${encodeURIComponent(sessionId)}${encodedPath}`;
}

export function setSessionDocument(
    documents: SessionDocuments,
    sessionId: string,
    document: EditorDocument,
): SessionDocuments {
    return {
        ...documents,
        [sessionId]: {
            ...documents[sessionId],
            [document.path]: document,
        },
    };
}

/**
 * Manages the open-tabs bookkeeping only (add tab, update dirty flag). Which WorkItem is focused is
 * `activeTab`, owned exclusively by `activateWork` in App.tsx — this function never touches it.
 */
export function updateEditorTabState(
    state: SessionState,
    path: string,
    dirty: boolean,
): SessionState {
    const existing = state.openTabs.find((tab) => tab.path === path);
    if (existing?.dirty === dirty) return state;
    return {
        ...state,
        openTabs: existing
            ? state.openTabs.map((tab) => (tab.path === path ? { ...tab, dirty } : tab))
            : [...state.openTabs, { path, dirty }],
    };
}

/** Disk state always wins, even over a dirty buffer, by explicit Caxri product policy. */
export function replaceWithExternalDocument(document: FileDocument): EditorDocument {
    return { ...document, dirty: false };
}

/** Clear only reloaded tab dirtiness so delayed file reads cannot overwrite newer layout or inspector choices. */
export function markTabsClean(state: SessionState, paths: readonly string[]): SessionState {
    const reloadedPaths = new Set(paths);
    return {
        ...state,
        openTabs: state.openTabs.map((tab) =>
            reloadedPaths.has(tab.path) ? { ...tab, dirty: false } : tab,
        ),
    };
}
