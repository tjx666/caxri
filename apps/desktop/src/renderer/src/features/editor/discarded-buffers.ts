import { parseExternalEditorTab } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';
import type { EditorDocument } from '@desktop-shared/editor-state';

import { translate } from '../../i18n';
import { getSessionDocuments, useSessionViewStore } from '../../stores/session-view';
import type { ToastActionParameters } from '../../stores/toast-actions';
import { pushToast } from '../../stores/toasts';
import { sessionStateOf } from './session-pane-state';

type RestoreTarget = ToastActionParameters['editor.restoreDiscardedChanges'];

/**
 * Upper bound on remembered discarded buffers. Each entry is a whole document body, so the stash cannot grow with the
 * window's lifetime; the oldest discard is the one least likely to still be wanted.
 */
const DISCARDED_BUFFER_LIMIT = 20;

/**
 * Unsaved buffers that a newer disk state replaced (ADR 0013: disk wins), keyed by Session, Workbench Root, and path.
 *
 * The text lives here rather than in the notification because a notification's follow-up must stay plain data and must
 * never carry a document body (`ToastActionParameters`): the notification names the documents, and this module holds
 * what "Restore My Changes" puts back. It is memory-only and dies with the Renderer, like the buffers it backs up.
 */
const discardedBuffers = new Map<string, string>();

/**
 * Stash keys a restore already used, so a later click on the same notice says so instead of blaming a closed file. Only
 * keys, never text, and bounded like the stash: a new discard of the same document clears its entry.
 */
const restoredBuffers = new Set<string>();

function bufferKey(sessionId: string, workbenchRootProjectId: string, path: string): string {
    return `${sessionId}\0${workbenchRootProjectId}\0${path}`;
}

/**
 * Keeps the text of dirty buffers that are about to be replaced by their on-disk state, so the user can take them back.
 */
export function stashDiscardedBuffers(
    sessionId: string,
    workbenchRootProjectId: string,
    documents: ReadonlyArray<Pick<EditorDocument, 'content' | 'path'>>,
): void {
    for (const document of documents) {
        const key = bufferKey(sessionId, workbenchRootProjectId, document.path);
        // Re-inserting moves the entry to the end, so eviction below drops the oldest discard.
        discardedBuffers.delete(key);
        restoredBuffers.delete(key);
        discardedBuffers.set(key, document.content);
    }
    while (discardedBuffers.size > DISCARDED_BUFFER_LIMIT) {
        const oldest = discardedBuffers.keys().next();
        if (oldest.done) break;
        discardedBuffers.delete(oldest.value);
    }
}

/**
 * The notice for unsaved buffers a newer disk state just replaced. It names the loss rather than the reload: the reload
 * is routine, and what the user needs to learn is that their typing is gone and can still be taken back.
 */
function discardedChangesMessage(names: readonly string[]): string {
    return names.length === 1
        ? translate('editor.externalSync.discardedOne', { name: names[0] })
        : translate('editor.externalSync.discardedOther', { count: names.length });
}

/**
 * Stashes unsaved buffers a newer disk state replaced and announces the loss with "Restore My Changes". Shared by the
 * live watcher and by a backup from an earlier launch whose file changed on disk while Caxri was closed.
 */
export function announceDiscardedBuffers(
    sessionId: string,
    workbenchRootProjectId: string,
    documents: ReadonlyArray<Pick<EditorDocument, 'content' | 'path'>>,
): void {
    stashDiscardedBuffers(sessionId, workbenchRootProjectId, documents);
    if (documents.length === 0) return;
    const name = (document: Pick<EditorDocument, 'path'>) =>
        parseExternalEditorTab(document.path)?.name ?? pathBasename(document.path);
    /**
     * A 4-second auto-dismiss would let this notice vanish while the user is away from the window, silently taking the
     * only way back to the discarded buffer with it. This event already cost the user unsaved work, so it stays until
     * explicitly dismissed, and it is a warning: the editor still works, but on terms the user did not choose.
     */
    pushToast('warning', discardedChangesMessage(documents.map(name)), {
        persist: true,
        dismissOnSuccess: true,
        action: {
            id: 'editor.restoreDiscardedChanges',
            params: {
                sessionId,
                workbenchRootProjectId,
                paths: documents.map((document) => document.path),
            },
        },
    });
}

/**
 * The documents a restore would write back into, with the text each one would get. A document is skipped when its stash
 * was already used or evicted, its tab was closed, or the user has typed into it since the reload: restoring then would
 * silently throw away the newer edit, which is the very loss this follow-up exists to undo.
 */
function restorableBuffers(target: RestoreTarget): Array<{ path: string; content: string }> {
    if (sessionStateOf(target.sessionId)?.workbenchRootProjectId !== target.workbenchRootProjectId)
        return [];
    const cached = getSessionDocuments(target.sessionId, target.workbenchRootProjectId) ?? {};
    return target.paths.flatMap((path) => {
        const content = discardedBuffers.get(
            bufferKey(target.sessionId, target.workbenchRootProjectId, path),
        );
        const current = Object.hasOwn(cached, path) ? cached[path] : undefined;
        return content === undefined || !current || current.dirty || current.readOnly
            ? []
            : [{ path, content }];
    });
}

function dropOldestRestored(): void {
    while (restoredBuffers.size > DISCARDED_BUFFER_LIMIT) {
        const oldest = restoredBuffers.values().next();
        if (oldest.done) break;
        restoredBuffers.delete(oldest.value);
    }
}

export function discardedChangesUnavailableReason(target: RestoreTarget): string | undefined {
    if (restorableBuffers(target).length > 0) return undefined;
    return translate(
        target.paths.every((path) =>
            restoredBuffers.has(bufferKey(target.sessionId, target.workbenchRootProjectId, path)),
        )
            ? 'editor.discarded.alreadyRestored'
            : 'editor.discarded.unavailable',
    );
}

/**
 * Puts the discarded text back as an unsaved buffer over the on-disk version, so the user decides what to keep by
 * saving or not. Each stash is used once.
 */
export function restoreDiscardedChanges(target: RestoreTarget): void {
    for (const { path, content } of restorableBuffers(target)) {
        const key = bufferKey(target.sessionId, target.workbenchRootProjectId, path);
        discardedBuffers.delete(key);
        restoredBuffers.add(key);
        dropOldestRestored();
        useSessionViewStore
            .getState()
            .updateDocumentContent(target.sessionId, path, content, target.workbenchRootProjectId);
    }
}

/**
 * Test seam: the stash is module state shared by every editor in the window.
 */
export function clearDiscardedBuffers(): void {
    discardedBuffers.clear();
    restoredBuffers.clear();
}
