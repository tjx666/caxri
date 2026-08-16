import type { FileDocument, SessionState } from './types';

export type EditorTabCloseMode = 'all' | 'one' | 'others' | 'right';

export interface EditorDocument extends FileDocument {
    dirty: boolean;
}

export type SessionDocuments = Record<string, Record<string, EditorDocument>>;

/**
 * Monaco models are URI-keyed, so Session identity must be part of the URI even for a shared root.
 */
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
 * Durable Session state records tab placement only because unsaved document bodies are Renderer-owned.
 */
export function withoutEditorTabDirtiness(state: SessionState): SessionState {
    if (state.openTabs.every((tab) => !tab.dirty)) return state;
    return {
        ...state,
        openTabs: state.openTabs.map((tab) => ({ ...tab, dirty: false })),
    };
}

/**
 * Rebuilds transient tab dirtiness exclusively from the document bodies that still exist.
 */
export function reconcileEditorTabDirtiness(
    state: SessionState,
    documents: Readonly<Record<string, EditorDocument>> | undefined,
): SessionState {
    let isChanged = false;
    const openTabs = state.openTabs.map((tab) => {
        const isDirty = documents?.[tab.path]?.dirty === true;
        if (tab.dirty === isDirty && (!isDirty || !tab.preview)) return tab;
        isChanged = true;
        return isDirty ? { path: tab.path, dirty: true } : { ...tab, dirty: false };
    });
    // The type-aware checker's narrowing does not account for `isChanged` being reassigned inside
    // the `.map` callback above (`tsc --strict` sees it correctly as `boolean`, not always `false`);
    // treating this as dead code would drop every real dirtiness change.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- isChanged is reassigned inside the map callback; checker narrowing is a false positive
    return isChanged ? { ...state, openTabs } : state;
}

/**
 * Manages the open-tabs bookkeeping only (add tab, update dirty flag). Which WorkItem is focused is `activeTab`, owned
 * exclusively by `activateWork` in app.tsx — this function never touches it.
 */
export function updateEditorTabState(
    state: SessionState,
    path: string,
    isDirty: boolean,
): SessionState {
    const existing = state.openTabs.find((tab) => tab.path === path);
    if (existing?.dirty === isDirty && (!isDirty || !existing.preview)) return state;
    return {
        ...state,
        openTabs: existing
            ? state.openTabs.map((tab) =>
                  tab.path === path
                      ? {
                            path: tab.path,
                            dirty: isDirty,
                            ...(tab.preview && !isDirty && { preview: true }),
                        }
                      : tab,
              )
            : [...state.openTabs, { path, dirty: isDirty }],
    };
}

/**
 * Opens one replaceable clean preview while preserving every pinned or dirty editor.
 */
export function openEditorTabState(
    state: SessionState,
    path: string,
    isPreview: boolean,
): { replacedPath?: string; state: SessionState } {
    const existing = state.openTabs.find((tab) => tab.path === path);
    if (existing) {
        if (isPreview || !existing.preview) return { state };
        return {
            state: {
                ...state,
                openTabs: state.openTabs.map((tab) =>
                    tab.path === path ? { path: tab.path, dirty: tab.dirty } : tab,
                ),
            },
        };
    }

    const nextTab = { path, dirty: false, ...(isPreview && { preview: true as const }) };
    if (!isPreview) return { state: { ...state, openTabs: [...state.openTabs, nextTab] } };
    const previewIndex = state.openTabs.findIndex((tab) => tab.preview && !tab.dirty);
    if (previewIndex === -1) return { state: { ...state, openTabs: [...state.openTabs, nextTab] } };
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
    if (targetIndex === -1) return [];
    if (mode === 'all') return openTabs.map((tab) => tab.path);
    if (mode === 'one') return [targetPath];
    if (mode === 'others')
        return openTabs.reduce<string[]>((paths, tab) => {
            if (tab.path !== targetPath) paths.push(tab.path);
            return paths;
        }, []);
    return openTabs.slice(targetIndex + 1).map((tab) => tab.path);
}

/**
 * Disk state always wins, even over a dirty buffer, by explicit Caxri product policy.
 */
export function replaceWithExternalDocument(document: FileDocument): EditorDocument {
    return { ...document, dirty: false };
}

/**
 * Clear only reloaded tab dirtiness so delayed file reads cannot overwrite newer layout or inspector choices.
 */
export function markTabsClean(state: SessionState, paths: readonly string[]): SessionState {
    const reloadedPaths = new Set(paths);
    return {
        ...state,
        openTabs: state.openTabs.map((tab) =>
            reloadedPaths.has(tab.path) ? { ...tab, dirty: false } : tab,
        ),
    };
}
