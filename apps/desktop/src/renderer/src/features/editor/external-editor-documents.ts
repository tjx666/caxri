import { externalEditorTabPath, isExternalEditorTabPath } from '@caxri/protocol';

import { getSessionDocuments, useSessionViewStore } from '../../stores/session-view';
import { useWorkbenchStore } from '../../stores/workbench';
import { didOpenEditorTabForSession } from './document-commands';

interface ExternalEditorDocumentResult {
    content: string;
    displayPath: string;
    id: string;
    mtimeMs: number;
    name: string;
    size: number;
}

/**
 * Opens content that Main already authorized and read without routing its absolute path through Project file IPC.
 *
 * Reopening a file that is already open reuses its tab. A clean buffer takes the fresh read; a dirty one is kept, so
 * reopening never discards unsaved edits.
 */
export function openExternalEditorDocument({
    sessionId,
    workbenchProjectId,
    document,
}: {
    sessionId: string;
    workbenchProjectId: string;
    document: ExternalEditorDocumentResult;
}): string | false {
    const sessionState = useWorkbenchStore
        .getState()
        .bootstrap?.sessionStates.find(
            (state) =>
                state.sessionId === sessionId && state.workbenchProjectId === workbenchProjectId,
        );
    if (!sessionState) return false;
    const [existingPath, existing] =
        Object.entries(getSessionDocuments(sessionId, workbenchProjectId) ?? {}).find(
            ([path, cached]) =>
                isExternalEditorTabPath(path) &&
                cached.ephemeral &&
                cached.displayPath === document.displayPath,
        ) ?? [];
    if (existingPath && existing?.dirty)
        return didOpenEditorTabForSession(sessionId, existingPath) && existingPath;
    const path = existingPath ?? externalEditorTabPath(document.id, document.name);
    const view = useSessionViewStore.getState();
    const didCache = view.cacheDocument(
        sessionId,
        { ...document, path, dirty: false, ephemeral: true },
        workbenchProjectId,
    );
    if (!didCache) return false;
    if (!didOpenEditorTabForSession(sessionId, path)) {
        view.evictDocument(sessionId, path, workbenchProjectId);
        return false;
    }
    return path;
}
