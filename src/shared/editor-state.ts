import type { FileDocument, SessionState } from './types';

export interface EditorDocument extends FileDocument {
    dirty: boolean;
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
