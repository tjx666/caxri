import { isVirtualEditorTabPath, remapPaneLayoutPaths } from '@caxri/protocol';

import { translate } from '../../i18n';
import { remapPath } from '../../lib/file-path';
import { getBootstrap, getProjectSessionIds, getSessionProjectId } from '../../stores/selectors';
import { useSessionViewStore } from '../../stores/session-view';
import { patchSessionState, persistSessionState } from '../../stores/workbench';
import { remapPendingDocumentOperations } from './pending-document-operations';
import { sessionStateOf } from './session-pane-state';

function remapOpenEditorsInSession(
    sessionId: string,
    workbenchProjectId: string,
    previousPath: string,
    nextPath: string,
    isDurable = false,
    operationId?: string,
): Promise<boolean> | undefined {
    const current = sessionStateOf(sessionId);
    const isRootIsCurrent = current?.workbenchProjectId === workbenchProjectId;
    if (
        isDurable &&
        operationId &&
        isRootIsCurrent &&
        current.editorRemapOperationId === operationId
    )
        return persistSessionState(current, {
            failureLabel: translate('editor.document.moveStateSaveFailed'),
            reportFailure: false,
            retainOnFailure: true,
        });
    remapPendingDocumentOperations(sessionId, workbenchProjectId, previousPath, nextPath);
    if (previousPath === nextPath) return isDurable ? Promise.resolve(true) : undefined;
    useSessionViewStore
        .getState()
        .remapDocuments(sessionId, previousPath, nextPath, workbenchProjectId);
    if (!current || !isRootIsCurrent) return isDurable ? Promise.resolve(true) : undefined;
    const nextState = {
        ...current,
        paneLayout: remapPaneLayoutPaths(current.paneLayout, (path) =>
            isVirtualEditorTabPath(path) ? path : remapPath(path, previousPath, nextPath),
        ),
        ...(operationId && { editorRemapOperationId: operationId }),
    };
    const failureLabel = translate('editor.document.moveStateSaveFailed');
    if (isDurable)
        return persistSessionState(nextState, {
            failureLabel,
            reportFailure: false,
            retainOnFailure: true,
        });
    patchSessionState(nextState, failureLabel);
    return undefined;
}

/**
 * Keeps every same-Project Session's normal tabs and dirty buffers attached after a move.
 */
export function remapOpenEditors(sessionId: string, previousPath: string, nextPath: string): void {
    const workbenchProjectId = getSessionProjectId(sessionId);
    if (!workbenchProjectId) return;
    for (const projectSessionId of getProjectSessionIds(sessionId))
        // Fire-and-forget: the non-durable remap only touches in-memory Renderer state and never
        // rejects, so there is nothing for this loop to await or react to.
        void remapOpenEditorsInSession(
            projectSessionId,
            workbenchProjectId,
            previousPath,
            nextPath,
        );
}

/**
 * Remaps transient state for the originating root; Server acknowledgement owns inactive storage.
 */
export async function remapOpenEditorsDurably(
    sessionId: string,
    workbenchProjectId: string,
    operationId: string,
    previousPath: string,
    nextPath: string,
): Promise<void> {
    const saved = await Promise.all(
        (getBootstrap()?.sessions.map((session) => session.id) ?? [sessionId]).map(
            (projectSessionId) =>
                remapOpenEditorsInSession(
                    projectSessionId,
                    workbenchProjectId,
                    previousPath,
                    nextPath,
                    true,
                    operationId,
                ) ?? Promise.resolve(true),
        ),
    );
    if (saved.some((result) => !result))
        throw new Error(translate('editor.document.moveStateSaveFailed'));
}
