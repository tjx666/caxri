import {
    errorMessage,
    externalEditorTabPath,
    filePreviewTabPath,
    isExternalEditorTabPath,
} from '@caxri/protocol';

import { translate } from '../../i18n';
import { getSelectedSession } from '../../stores/selectors';
import { getSessionDocuments, useSessionViewStore } from '../../stores/session-view';
import { pushToast } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { openFilePreview } from '../preview/preview-commands';
import { shouldOpenAsPreview } from '../preview/preview-registry';
import { didOpenEditorTabForSession } from './document-commands';
import { openLinkedExternalFile } from './external-document-client';

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
 * reopening never discards unsaved edits. A PDF opens straight on its preview tab.
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
    /**
     * A format with no text form (a PDF) opens on its preview, as a Project file does: Main registered the document
     * without a text read, and the preview fetches the bytes under that grant. The cached entry still carries the
     * display path and the ephemeral lifetime.
     */
    const tabPath = shouldOpenAsPreview(document.name) ? filePreviewTabPath(path) : path;
    if (!didOpenEditorTabForSession(sessionId, tabPath)) {
        view.evictDocument(sessionId, path, workbenchProjectId);
        return false;
    }
    return path;
}

/**
 * Follows a link in an external document's preview to another file in that document's folder. Main resolves and reads
 * it under the linking document's grant; the file opens as an external document of its own, and a previewable one
 * (another Markdown file) also opens in the reading view, as a Project link does. Never rejects.
 */
export async function openLinkedExternalDocument(
    source: { externalDocumentId: string; directory: string },
    path: string,
    shouldPreview: boolean,
): Promise<void> {
    const session = getSelectedSession();
    const prefix = source.directory.endsWith('/') ? source.directory : `${source.directory}/`;
    if (!session || !path.startsWith(prefix)) return;
    try {
        const document = await openLinkedExternalFile(
            source.externalDocumentId,
            path.slice(prefix.length),
        );
        const opened = openExternalEditorDocument({
            sessionId: session.id,
            workbenchProjectId: session.workbenchProjectId,
            document,
        });
        if (!opened) throw new Error(translate('editor.external.openInSessionFailed'));
        if (shouldPreview) openFilePreview(opened);
    } catch (error) {
        pushToast('error', errorMessage(error, translate('editor.external.openFailed')));
    }
}
