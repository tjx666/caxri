import type { MethodResult, MutableFileEntry } from '@caxri/protocol';

import { translate } from '../../../i18n';
import { readClipboardFilePaths, writeClipboardText } from '../../../lib/clipboard';
import { isOsFileReferenceRefused } from '../../../lib/file-drag';
import { parentDirectoryPath } from '../../../lib/file-path';
import { getSessionProjectId } from '../../../stores/selectors';
import { pushToast, tryCommand } from '../../../stores/toasts';
import { closeOpenEditorsUnderPath, hasUnsavedChangesUnderPath } from '../../editor/document-trash';
import { copyItem, invalidateDirectory, moveFile } from './file-actions';
import type { FileClipboardEntry } from './file-clipboard';
import { useFileClipboardStore } from './file-clipboard';
import type { ResourceExplorerClient } from './resource-explorer-client';
import { activeResourceExplorerScope } from './resource-explorer-scope-store';

/**
 * Arms Cut or Copy for a later paste, in this Project or another one.
 *
 * The path also goes to the system clipboard as text. Besides letting it be pasted elsewhere as a path, that replaces
 * whatever Finder copied earlier, so a later Paste takes this item rather than a stale Finder copy: the tree pastes
 * Finder's files whenever the system clipboard still holds them (`pasteIntoDirectory`).
 */
export function rememberFile(path: string, mode: FileClipboardEntry['mode']): void {
    const scope = activeResourceExplorerScope();
    if (!scope) return;
    useFileClipboardStore.getState().set({ mode, path, sessionId: scope.sessionId });
    void writePathToClipboard(path);
}

async function writePathToClipboard(path: string): Promise<void> {
    try {
        await writeClipboardText(path);
    } catch {
        // Best effort: a failed write only means an older Finder copy may still win the next paste.
    }
}

/**
 * Cmd+V or Paste into `directory`: files Finder put on the system clipboard win, since copying in Caxri replaces them
 * ({@link rememberFile}); otherwise the item cut or copied in Caxri.
 */
export async function pasteIntoDirectory(
    client: ResourceExplorerClient,
    sessionId: string,
    directory: string,
): Promise<MutableFileEntry | MethodResult<'files.move'> | undefined> {
    // An SSH Host window takes no Finder files, as with a drop (see `isOsFileReferenceRefused`).
    const finderPaths = isOsFileReferenceRefused()
        ? []
        : await tryCommand(translate('viewContainers.files.copyFailed'), readClipboardFilePaths);
    if (finderPaths && finderPaths.length > 0)
        return importOsFiles(client, sessionId, finderPaths, directory);
    const clipboard = useFileClipboardStore.getState().entry;
    return clipboard ? pasteFile(client, sessionId, directory, clipboard) : undefined;
}

export async function pasteFile(
    client: ResourceExplorerClient,
    sessionId: string,
    directory: string,
    clipboard: FileClipboardEntry,
): Promise<MutableFileEntry | MethodResult<'files.move'> | undefined> {
    // Named whenever the item was cut or copied in another Session: its Project, or its worktree, can differ.
    const source =
        clipboard.sessionId === sessionId
            ? undefined
            : ({ kind: 'session', sessionId: clipboard.sessionId } as const);
    if (clipboard.mode === 'copy')
        return copyItem(client, sessionId, clipboard.path, directory, source);
    const sourceProjectId = getSessionProjectId(clipboard.sessionId);
    const isLeavesProject =
        sourceProjectId !== undefined && sourceProjectId !== getSessionProjectId(sessionId);
    /**
     * A move reconciles open editors only in the destination Project, so a dirty tab in the source Project would keep
     * its old path and recreate the file there on save. Refused rather than silently dropping those edits.
     */
    if (isLeavesProject && hasUnsavedChangesUnderPath(sourceProjectId, clipboard.path)) {
        pushToast('error', translate('viewContainers.files.moveUnsavedToProject'));
        return undefined;
    }
    const moved = await moveFile(client, sessionId, clipboard.path, directory, source);
    if (!moved) return undefined;
    useFileClipboardStore.getState().clear();
    if (isLeavesProject) await forgetSourceEditors(client, sourceProjectId, clipboard.path);
    return moved;
}

/**
 * Closes the source Project's tabs on an item that moved to another Project, forgets them in its Server-kept layout (as
 * a Trash does, issue #909), and refreshes the folder the item left.
 */
async function forgetSourceEditors(
    client: ResourceExplorerClient,
    sourceProjectId: string,
    path: string,
): Promise<void> {
    closeOpenEditorsUnderPath(sourceProjectId, path);
    await tryCommand(translate('viewContainers.files.moveCleanupFailed'), () =>
        client.forgetEditorPath(sourceProjectId, path),
    );
    await invalidateDirectory(client, parentDirectoryPath(path));
}

/**
 * Copies files the user dropped or pasted from Finder into `directory`. Finder's items are only read, never moved, and
 * each keeps both copies on a name clash. Runs one at a time so every item picks its own free name; returns the last
 * one copied, for the caller to select.
 */
export async function importOsFiles(
    client: ResourceExplorerClient,
    sessionId: string,
    paths: readonly string[],
    directory: string,
): Promise<MutableFileEntry | undefined> {
    let last: MutableFileEntry | undefined;
    for (const path of paths) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential on purpose; see above
        const copied = await copyItem(client, sessionId, path, directory, { kind: 'external' }); // eslint-disable-line no-await-in-loop -- see above
        if (copied) last = copied;
    }
    return last;
}
