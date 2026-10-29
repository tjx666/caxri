import {
    externalEditorTabPath,
    filePreviewTabPath,
    isExternalEditorTabPath,
} from '@caxri/protocol';
import { editorModelPath } from '@desktop-shared/editor-state';

import { translate } from '../../i18n';
import { getSelectedSession } from '../../stores/selectors';
import {
    getSessionDocuments,
    sessionViewScope,
    useSessionViewStore,
} from '../../stores/session-view';
import { describeFailureKey, pushToast } from '../../stores/toasts';
import { useWorkbenchStore } from '../../stores/workbench';
import { openFilePreview } from '../preview/preview-commands';
import { shouldOpenAsPreview } from '../preview/preview-registry';
import { didOpenEditorTabForSession } from './document-commands';
import { focusEditor } from './editor-reveal';
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
 *
 * `focus` moves keyboard focus into the editor once it mounts, as a Project file opened with `focus` does. Without it,
 * tab focus recovery lands on the tab button after the opener (the Go to File dialog) closes, and the button shows its
 * focus ring.
 */
export function openExternalEditorDocument({
    sessionId,
    workbenchRootProjectId,
    document,
    focus = false,
}: {
    sessionId: string;
    workbenchRootProjectId: string;
    document: ExternalEditorDocumentResult;
    focus?: boolean;
}): string | false {
    const sessionState = useWorkbenchStore
        .getState()
        .bootstrap?.sessionStates.find(
            (state) =>
                state.sessionId === sessionId &&
                state.workbenchRootProjectId === workbenchRootProjectId,
        );
    if (!sessionState) return false;
    const [existingPath, existing] =
        Object.entries(getSessionDocuments(sessionId, workbenchRootProjectId) ?? {}).find(
            ([path, cached]) =>
                isExternalEditorTabPath(path) &&
                cached.ephemeral &&
                cached.displayPath === document.displayPath,
        ) ?? [];
    const focusOpened = (openedPath: string): void => {
        if (focus)
            focusEditor(
                editorModelPath(sessionViewScope(sessionId, workbenchRootProjectId), openedPath),
            );
    };
    if (existingPath && existing?.dirty) {
        if (!didOpenEditorTabForSession(sessionId, existingPath)) return false;
        focusOpened(existingPath);
        return existingPath;
    }
    const path = existingPath ?? externalEditorTabPath(document.id, document.name);
    const view = useSessionViewStore.getState();
    const didCache = view.cacheDocument(
        sessionId,
        { ...document, path, dirty: false, ephemeral: true },
        workbenchRootProjectId,
    );
    if (!didCache) return false;
    /**
     * A format with no text form (a PDF) opens on its preview, as a Project file does: Main registered the document
     * without a text read, and the preview fetches the bytes under that grant. The cached entry still carries the
     * display path and the ephemeral lifetime.
     */
    const tabPath = shouldOpenAsPreview(document.name) ? filePreviewTabPath(path) : path;
    if (!didOpenEditorTabForSession(sessionId, tabPath)) {
        view.evictDocument(sessionId, path, workbenchRootProjectId);
        return false;
    }
    if (tabPath === path) focusOpened(path);
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
            workbenchRootProjectId: session.workbenchRootProjectId,
            document,
        });
        if (!opened) throw new Error(translate('editor.external.openInSessionFailed'));
        if (shouldPreview) openFilePreview(opened);
    } catch (error) {
        pushToast('error', describeFailureKey(error, 'editor.external.openFailed', translate));
    }
}
