import {
    closeTabs,
    isPathAtOrBelow,
    isVirtualEditorTabPath,
    listPaneTabs,
    parseFilePreviewTab,
} from '@caxri/protocol';

import { translate } from '../../i18n';
import { getBootstrap } from '../../stores/selectors';
import { getSessionDocuments, useSessionViewStore } from '../../stores/session-view';
import { patchSessionState } from '../../stores/workbench';
import { discardPendingDocumentOperations } from './pending-document-operations';
import { sessionStateOf } from './session-pane-state';

/**
 * Every Session that can hold editor state for one Workbench Root. A file path belongs to the root it was authorized
 * against, and a Session parked on a different root keeps the old root's documents cached under that root's scope, so
 * the set cannot be narrowed to the Sessions currently showing the root. `getProjectSessionIds` narrows exactly that
 * way and therefore misses them; a dirty buffer left behind recreates a trashed file on the next save (issue #738).
 * `remapOpenEditorsDurably` already reconciles the same full set for renames.
 */
function workbenchRootSessionIds(): string[] {
    return getBootstrap()?.sessions.map((session) => session.id) ?? [];
}

/**
 * The file a tab shows, when it shows one: a source tab's own path, or the source of a preview tab. A PDF opens only as
 * a preview, so skipping previews would leave a trashed PDF on screen with nothing else to close.
 */
function tabFilePath(path: string): string | undefined {
    if (!isVirtualEditorTabPath(path)) return path;
    return parseFilePreviewTab(path)?.path;
}

function closeOpenEditorsUnderPathInSession(
    sessionId: string,
    workbenchProjectId: string,
    path: string,
): void {
    discardPendingDocumentOperations(sessionId, path);
    /**
     * Evicted before the tab check, and for every root-holding Session: a dirty buffer whose tab is already closed is
     * still unsaved content that reopens with the persisted layout, which is the shape that resurrected the file.
     */
    useSessionViewStore.getState().evictDocumentsUnderPath(sessionId, path, workbenchProjectId);
    const current = sessionStateOf(sessionId);
    // Only this root's pane layout is in memory; closing tabs from a Session parked elsewhere would close the wrong root.
    if (!current || current.workbenchProjectId !== workbenchProjectId) return;
    const closingIds = listPaneTabs(current.paneLayout).flatMap(({ tab }) => {
        if (tab.resource.kind !== 'file') return [];
        const filePath = tabFilePath(tab.resource.path);
        return filePath && isPathAtOrBelow(filePath, path) ? [tab.id] : [];
    });
    if (closingIds.length === 0) return;
    patchSessionState(
        { ...current, paneLayout: closeTabs(current.paneLayout, closingIds) },
        translate('editor.document.trashStateSaveFailed'),
    );
}

/**
 * Closes matching normal editors and drops matching cached documents in every Session holding state for the trashed
 * path's Workbench Root, after Main confirms Trash.
 *
 * `workbenchProjectId` is the root the caller resolved _before_ it awaited the Trash confirmation. Re-deriving it here
 * would reintroduce the same defect from the other side: a Session can change roots while the dialog is open (an Agent
 * creating a worktree does it without the user touching anything when `workbench.newWorktreeBehavior` is
 * `continueAutomatically`) and the cleanup would then miss the root the confirmation was actually about.
 */
export function closeOpenEditorsUnderPath(workbenchProjectId: string, path: string): void {
    for (const rootSessionId of workbenchRootSessionIds())
        closeOpenEditorsUnderPathInSession(rootSessionId, workbenchProjectId, path);
}

/**
 * True when a file at or below `path` has unsaved edits in any Session holding state for this Workbench Root. Lets a
 * Trash confirmation stop promising full recoverability when it would actually discard a dirty buffer that was never
 * written to disk.
 *
 * The evidence is the scoped document cache rather than the pane layout, deliberately: a Session parked on another root
 * has no layout for this one in memory, and the cache is what recreates the trashed file once the user switches back
 * and saves. Reading the same state {@link closeOpenEditorsUnderPath} evicts is the point: the confirmation promising
 * one thing while the cleanup discards another is the defect shape issue #738 reported. A dirty document always has a
 * cache entry, so this still covers every open dirty tab.
 */
export function hasUnsavedChangesUnderPath(workbenchProjectId: string, path: string): boolean {
    return workbenchRootSessionIds().some((rootSessionId) =>
        Object.entries(getSessionDocuments(rootSessionId, workbenchProjectId) ?? {}).some(
            ([candidate, document]) =>
                document.dirty &&
                !isVirtualEditorTabPath(candidate) &&
                isPathAtOrBelow(candidate, path),
        ),
    );
}
