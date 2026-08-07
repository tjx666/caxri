import type { FileDocument, SessionState } from './types';

export type EditorTabCloseMode = 'all' | 'one' | 'others' | 'right';

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
    if (existing?.dirty === dirty && (!dirty || !existing.preview)) return state;
    return {
        ...state,
        openTabs: existing
            ? state.openTabs.map((tab) =>
                  tab.path === path
                      ? {
                            path: tab.path,
                            dirty,
                            ...(tab.preview && !dirty ? { preview: true } : {}),
                        }
                      : tab,
              )
            : [...state.openTabs, { path, dirty }],
    };
}

/** Opens one replaceable clean preview while preserving every pinned or dirty editor. */
export function openEditorTabState(
    state: SessionState,
    path: string,
    preview: boolean,
): { replacedPath?: string; state: SessionState } {
    const existing = state.openTabs.find((tab) => tab.path === path);
    if (existing) {
        if (preview || !existing.preview) return { state };
        return {
            state: {
                ...state,
                openTabs: state.openTabs.map((tab) =>
                    tab.path === path ? { path: tab.path, dirty: tab.dirty } : tab,
                ),
            },
        };
    }

    const nextTab = { path, dirty: false, ...(preview ? { preview: true as const } : {}) };
    if (!preview) return { state: { ...state, openTabs: [...state.openTabs, nextTab] } };
    const previewIndex = state.openTabs.findIndex((tab) => tab.preview && !tab.dirty);
    if (previewIndex < 0) return { state: { ...state, openTabs: [...state.openTabs, nextTab] } };
    const replacedPath = state.openTabs[previewIndex].path;
    const openTabs = [...state.openTabs];
    openTabs[previewIndex] = nextTab;
    return { replacedPath, state: { ...state, openTabs } };
}

export function pinEditorTabState(state: SessionState, path: string): SessionState {
    const existing = state.openTabs.find((tab) => tab.path === path);
    if (!existing?.preview) return state;
    return {
        ...state,
        openTabs: state.openTabs.map((tab) =>
            tab.path === path ? { path: tab.path, dirty: tab.dirty } : tab,
        ),
    };
}

export function editorTabPathsToClose(
    openTabs: SessionState['openTabs'],
    targetPath: string,
    mode: EditorTabCloseMode,
): string[] {
    const targetIndex = openTabs.findIndex((tab) => tab.path === targetPath);
    if (targetIndex < 0) return [];
    if (mode === 'all') return openTabs.map((tab) => tab.path);
    if (mode === 'one') return [targetPath];
    if (mode === 'others')
        return openTabs.reduce<string[]>((paths, tab) => {
            if (tab.path !== targetPath) paths.push(tab.path);
            return paths;
        }, []);
    return openTabs.slice(targetIndex + 1).map((tab) => tab.path);
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
