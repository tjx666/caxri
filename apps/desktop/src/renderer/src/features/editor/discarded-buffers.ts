import type { EditorDocument } from '@desktop-shared/editor-state';

import { getSessionDocuments, useSessionViewStore } from '../../stores/session-view';
import type { ToastActionParameters } from '../../stores/toast-actions';
import { sessionStateOf } from './document-commands';

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

function bufferKey(sessionId: string, workbenchProjectId: string, path: string): string {
    return `${sessionId}\0${workbenchProjectId}\0${path}`;
}

/**
 * Keeps the text of dirty buffers that are about to be replaced by their on-disk state, so the user can take them back.
 */
export function stashDiscardedBuffers(
    sessionId: string,
    workbenchProjectId: string,
    documents: readonly EditorDocument[],
): void {
    for (const document of documents) {
        const key = bufferKey(sessionId, workbenchProjectId, document.path);
        // Re-inserting moves the entry to the end, so eviction below drops the oldest discard.
        discardedBuffers.delete(key);
        discardedBuffers.set(key, document.content);
    }
    while (discardedBuffers.size > DISCARDED_BUFFER_LIMIT) {
        const oldest = discardedBuffers.keys().next();
        if (oldest.done) break;
        discardedBuffers.delete(oldest.value);
    }
}

/**
 * The documents a restore would write back into, with the text each one would get. A document is skipped when its stash
 * was already used or evicted, its tab was closed, or the user has typed into it since the reload: restoring then would
 * silently throw away the newer edit, which is the very loss this follow-up exists to undo.
 */
function restorableBuffers(target: RestoreTarget): Array<{ path: string; content: string }> {
    if (sessionStateOf(target.sessionId)?.workbenchProjectId !== target.workbenchProjectId)
        return [];
    const cached = getSessionDocuments(target.sessionId, target.workbenchProjectId) ?? {};
    return target.paths.flatMap((path) => {
        const content = discardedBuffers.get(
            bufferKey(target.sessionId, target.workbenchProjectId, path),
        );
        const current = Object.hasOwn(cached, path) ? cached[path] : undefined;
        return content === undefined || !current || current.dirty || current.readOnly
            ? []
            : [{ path, content }];
    });
}

export function discardedChangesUnavailableReason(target: RestoreTarget): string | undefined {
    return restorableBuffers(target).length > 0
        ? undefined
        : 'Your earlier changes can no longer be restored because the file was closed, edited again, or its Project changed.';
}

/**
 * Puts the discarded text back as an unsaved buffer over the on-disk version, so the user decides what to keep by
 * saving or not. Each stash is used once.
 */
export function restoreDiscardedChanges(target: RestoreTarget): void {
    for (const { path, content } of restorableBuffers(target)) {
        discardedBuffers.delete(bufferKey(target.sessionId, target.workbenchProjectId, path));
        useSessionViewStore
            .getState()
            .updateDocumentContent(target.sessionId, path, content, target.workbenchProjectId);
    }
}

/**
 * Test seam: the stash is module state shared by every editor in the window.
 */
export function clearDiscardedBuffers(): void {
    discardedBuffers.clear();
}
