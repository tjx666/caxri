import type { MutableFileEntry } from '@caxri/protocol';

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
import { outermostPaths } from './file-tree-selection';
import type { FileMoveSource, ResourceExplorerClient } from './resource-explorer-client';
import { activeResourceExplorerScope } from './resource-explorer-scope-store';

/**
 * Arms Cut or Copy of one entry or a whole multi-selection for a later paste, in this Project or another one.
 *
 * The paths also go to the system clipboard as text, one per line. Besides letting them be pasted elsewhere as paths,
 * that replaces whatever Finder copied earlier, so a later Paste takes these items rather than a stale Finder copy: the
 * tree pastes Finder's files whenever the system clipboard still holds them (`pasteIntoDirectory`).
 */
export function rememberFiles(paths: readonly string[], mode: FileClipboardEntry['mode']): void {
    const scope = activeResourceExplorerScope();
    if (!scope || paths.length === 0) return;
    useFileClipboardStore
        .getState()
        .set({ mode, paths: outermostPaths(paths), sessionId: scope.sessionId });
    void writePathsToClipboard(paths);
}

async function writePathsToClipboard(paths: readonly string[]): Promise<void> {
    try {
        await writeClipboardText(paths.join('\n'));
    } catch {
        // Best effort: a failed write only means an older Finder copy may still win the next paste.
    }
}

/**
 * Cmd+V or Paste into `directory`: files Finder put on the system clipboard win, since copying in Caxri replaces them
 * ({@link rememberFiles}); otherwise the items cut or copied in Caxri. Returns every entry that landed, in order.
 */
export async function pasteIntoDirectory(
    client: ResourceExplorerClient,
    sessionId: string,
    directory: string,
): Promise<readonly MutableFileEntry[]> {
    // An SSH Host window takes no Finder files, as with a drop (see `isOsFileReferenceRefused`).
    const finderPaths = isOsFileReferenceRefused()
        ? []
        : await tryCommand(translate('viewContainers.files.copyFailed'), readClipboardFilePaths);
    if (finderPaths && finderPaths.length > 0)
        return importOsFiles(client, sessionId, finderPaths, directory);
    const clipboard = useFileClipboardStore.getState().entry;
    return clipboard ? pasteFiles(client, sessionId, directory, clipboard) : [];
}

export async function pasteFiles(
    client: ResourceExplorerClient,
    sessionId: string,
    directory: string,
    clipboard: FileClipboardEntry,
): Promise<readonly MutableFileEntry[]> {
    // Named whenever the items were cut or copied in another Session: its Project, or its worktree, can differ.
    const source =
        clipboard.sessionId === sessionId
            ? undefined
            : ({ kind: 'session', sessionId: clipboard.sessionId } as const);
    if (clipboard.mode === 'copy') {
        const copied: MutableFileEntry[] = [];
        for (const path of clipboard.paths) {
            // Sequential so every copy picks its own free name in `directory`.
            // eslint-disable-next-line no-await-in-loop -- see above
            const entry = await copyItem(client, sessionId, path, directory, source);
            if (entry) copied.push(entry);
        }
        return copied;
    }
    const sourceProjectId = getSessionProjectId(clipboard.sessionId);
    const isLeavesProject =
        sourceProjectId !== undefined && sourceProjectId !== getSessionProjectId(sessionId);
    /**
     * A move reconciles open editors only in the destination Project, so a dirty tab in the source Project would keep
     * its old path and recreate the file there on save. Refused rather than silently dropping those edits.
     */
    if (
        isLeavesProject &&
        clipboard.paths.some((path) => hasUnsavedChangesUnderPath(sourceProjectId, path))
    ) {
        pushToast('error', translate('viewContainers.files.moveUnsavedToProject'));
        return [];
    }
    const moved = await moveFiles(client, sessionId, clipboard.paths, directory, source);
    if (moved.length === 0) return moved;
    // An entry that did not move (a canceled conflict, a failure) stays cut, so a second Paste can still take it.
    const movedFrom = new Set(moved.map((entry) => entry.previousPath));
    const left = clipboard.paths.filter((path) => !movedFrom.has(path));
    if (left.length === 0) useFileClipboardStore.getState().clear();
    else useFileClipboardStore.getState().set({ ...clipboard, paths: left });
    if (isLeavesProject)
        for (const entry of moved)
            // eslint-disable-next-line no-await-in-loop -- one cleanup per moved entry, in order
            await forgetSourceEditors(client, sourceProjectId, entry.previousPath);
    return moved;
}

/**
 * Moves each of `paths` into `directory` in turn (a dragged or cut multi-selection). Entries already in `directory`
 * stay put, since moving them there would only raise a conflict with themselves; a conflict prompt or failure on one
 * entry does not stop the rest. Returns every entry that moved.
 */
export async function moveFiles(
    client: ResourceExplorerClient,
    sessionId: string,
    paths: readonly string[],
    directory: string,
    source?: FileMoveSource,
): Promise<ReadonlyArray<MutableFileEntry & { previousPath: string }>> {
    const moved: Array<MutableFileEntry & { previousPath: string }> = [];
    for (const path of outermostPaths(paths)) {
        if (parentDirectoryPath(path) === directory) continue;
        // Sequential: each entry may raise its own conflict prompt.
        // eslint-disable-next-line no-await-in-loop -- see above
        const entry = await moveFile(client, sessionId, path, directory, source);
        if (entry) moved.push(entry);
    }
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
 * each keeps both copies on a name clash. Runs one at a time so every item picks its own free name; returns every item
 * copied, for the caller to select.
 */
export async function importOsFiles(
    client: ResourceExplorerClient,
    sessionId: string,
    paths: readonly string[],
    directory: string,
): Promise<readonly MutableFileEntry[]> {
    const copied: MutableFileEntry[] = [];
    for (const path of paths) {
        // react-doctor-disable-next-line react-doctor/async-await-in-loop -- sequential on purpose; see above
        const entry = await copyItem(client, sessionId, path, directory, { kind: 'external' }); // eslint-disable-line no-await-in-loop -- see above
        if (entry) copied.push(entry);
    }
    return copied;
}
