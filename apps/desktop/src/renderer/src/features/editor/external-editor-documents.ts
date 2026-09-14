import { externalEditorTabPath } from '@caxri/protocol';

import { useSessionViewStore } from '../../stores/session-view';
import { useWorkbenchStore } from '../../stores/workbench';
import { didOpenEditorTabForSession } from './document-commands';

interface ExternalEditorDocumentResult {
    content: string;
    displayPath: string;
    id: string;
    mtimeMs: number;
    name: string;
    readOnly: true;
    size: number;
}

/**
 * Opens content that Main already authorized and read without routing its absolute path through Project file IPC.
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
    const path = externalEditorTabPath(document.id, document.name);
    const view = useSessionViewStore.getState();
    const didCache = view.cacheDocument(
        sessionId,
        {
            ...document,
            path,
            dirty: false,
            ephemeral: true,
            readOnly: true,
        },
        workbenchProjectId,
    );
    if (!didCache) return false;
    if (!didOpenEditorTabForSession(sessionId, path)) {
        view.evictDocument(sessionId, path, workbenchProjectId);
        return false;
    }
    return path;
}
