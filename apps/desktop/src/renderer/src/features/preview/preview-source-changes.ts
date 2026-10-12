import type { ServerEvent } from '@caxri/protocol';

import { caxri } from '../../lib/caxri';

type FilesChangedPayload = Extract<ServerEvent, { event: 'files.changed' }>['payload'];

export interface PreviewSource {
    workbenchProjectId: string;
    path: string;
}

/**
 * Settle time before a binary preview re-reads its file. A save usually lands as several watcher events (truncate,
 * write, rename), and a PDF re-read decodes up to 32 MiB, so one burst should cost one read.
 */
const CHANGE_SETTLE_MS = 250;

/**
 * Whether a `files.changed` batch rewrote the file a binary preview shows.
 *
 * A deletion is not a reason to re-read: the view keeps what it has, and closing a deleted file's tab belongs to the
 * Files tree. An overflowed batch (the watcher dropped the per-file list) is ignored too: re-reading every open PDF on
 * every large checkout or install would cost far more than the rare stale page it prevents, and reopening the tab still
 * reads the file again.
 */
export function isPreviewSourceChange(
    payload: FilesChangedPayload,
    source: PreviewSource,
): boolean {
    return (
        payload.workbenchProjectId === source.workbenchProjectId &&
        payload.changes.some((change) => change.kind !== 'delete' && change.path === source.path)
    );
}

/**
 * Calls `onChange` once a burst of watcher events that rewrote the source has settled.
 */
export function subscribePreviewSourceChanges(
    source: PreviewSource,
    onChange: () => void,
): () => void {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = caxri.onEvent((event) => {
        if (event.event !== 'files.changed' || !isPreviewSourceChange(event.payload, source))
            return;
        clearTimeout(timer);
        timer = setTimeout(onChange, CHANGE_SETTLE_MS);
    });
    return () => {
        clearTimeout(timer);
        unsubscribe();
    };
}
