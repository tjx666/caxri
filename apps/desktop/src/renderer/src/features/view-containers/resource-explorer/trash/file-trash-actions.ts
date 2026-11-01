import type { MutableFileEntry } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { translate } from '../../../../i18n';
import { parentDirectoryPath } from '../../../../lib/file-path';
import { getSelectedSession, getSessionProjectId } from '../../../../stores/selectors';
import { describeFailureKey, pushToast, tryCommand } from '../../../../stores/toasts';
import {
    closeOpenEditorsUnderPath,
    hasUnsavedChangesUnderPath,
} from '../../../editor/document-trash';
import { invalidateDirectory } from '../file-actions';
import type { ResourceExplorerClient } from '../resource-explorer-client';
import { activeResourceExplorerScope, revealPathsInScope } from '../resource-explorer-scope-store';
import type { UndoableTrash } from './undoable-trash';
import { forgetUndoableTrash, rememberUndoableTrash, undoableTrashFor } from './undoable-trash';

/**
 * Moves `paths` (one row, or a Files multi-selection) to the Trash behind one confirmation and returns the paths that
 * reached it; empty when the user canceled or nothing moved.
 */
export async function trashFiles(
    client: ResourceExplorerClient,
    sessionId: string,
    paths: readonly string[],
): Promise<readonly string[]> {
    /**
     * Resolved once, before the confirmation, and reused for the cleanup afterwards. A Session can change its Workbench
     * Root while the dialog is open: an Agent creating a worktree does it with no user action under
     * `workbench.newWorktreeBehavior: continueAutomatically`, and re-deriving it after the await would clean a
     * different root than the one the user was asked about.
     */
    const workbenchRootProjectId = getSessionProjectId(sessionId);
    if (!workbenchRootProjectId || paths.length === 0) return [];
    /**
     * Checked before the request so Main's confirmation copy can stop promising full recoverability: Trash can only
     * restore the last bytes written to disk, never an unsaved buffer.
     */
    const hasUnsavedChanges = paths.some((path) =>
        hasUnsavedChangesUnderPath(workbenchRootProjectId, path),
    );
    const result = await tryCommand(translate('viewContainers.files.trashFailed'), () =>
        client.trash(paths, { hasUnsavedChanges }),
    );
    if (!result || 'canceled' in result) return [];
    const { failure, items } = result;
    for (const item of items) closeOpenEditorsUnderPath(workbenchRootProjectId, item.path);
    /**
     * Only this root's pane layout is in memory, so the call above cannot reach a Session parked on another root. Its
     * layout for this root lives on the Server, and a tab left there reopens stuck on `Loading file…` (issue #909).
     */
    await tryCommand(translate('viewContainers.files.trashCleanupFailed'), () =>
        Promise.all(
            items.map((item) => client.forgetEditorPath(workbenchRootProjectId, item.path)),
        ),
    );
    await Promise.all(
        [...new Set(items.map((item) => parentDirectoryPath(item.path)))].map((directory) =>
            invalidateDirectory(client, directory),
        ),
    );
    const receipts = items.flatMap((item) =>
        item.undoToken ? [{ name: item.name, undoToken: item.undoToken }] : [],
    );
    rememberUndoableTrash({ items: receipts, sessionId });
    if (failure)
        pushToast(
            'error',
            translate('viewContainers.files.trashedPartly', {
                count: items.length,
                name: pathBasename(failure.path),
                total: paths.length,
                reason: failure.message,
            }),
        );
    /**
     * A Trash that can be taken back (Cmd+Z in the tree) needs no notice: the rows disappearing are the feedback. Only
     * a Trash that discarded unsaved edits says so, in a persistent warning, since those edits are the one thing the
     * Trash cannot give back. The notification's Undo button covers one receipt; a batch is taken back with Cmd+Z.
     */
    if (hasUnsavedChanges) {
        const single = items.length === 1 ? items[0] : undefined;
        pushToast(
            'warning',
            single
                ? translate('viewContainers.files.trashedUnsaved', { name: single.name })
                : translate('viewContainers.files.trashedUnsavedMany', { count: items.length }),
            {
                persist: true,
                ...(single?.undoToken && {
                    action: {
                        id: 'files.undoTrash',
                        params: { sessionId, undoToken: single.undoToken, name: single.name },
                    },
                }),
            },
        );
    }
    return items.map((item) => item.path);
}

/**
 * Restores one Trash receipt and refreshes the folder it returns to. Every outcome is reported here: the original path
 * being occupied is named and leaves the Trash copy untouched. Returns the restored path, or `undefined` on failure.
 */
async function restoreTrashedItem(
    client: ResourceExplorerClient,
    undoToken: string,
    name: string,
    onConflict?: () => void,
): Promise<string | undefined> {
    let restored: MutableFileEntry;
    try {
        restored = await client.restoreTrashed(undoToken);
        forgetUndoableTrash(undoToken);
    } catch (error) {
        // A name conflict is the one failure the user can fix and retry; every other one leaves nothing to retry.
        if (!(isCaxriError(error) && error.code === 'CONFLICT')) forgetUndoableTrash(undoToken);
        if (isCaxriError(error) && error.code === 'CONFLICT') {
            onConflict?.();
            pushToast('error', translate('viewContainers.files.restoreConflict', { name }));
        } else if (isCaxriError(error) && error.code === 'NOT_FOUND')
            pushToast('error', translate('viewContainers.files.restoreGone', { name }));
        else
            pushToast(
                'error',
                describeFailureKey(error, 'viewContainers.files.restoreFailed', translate),
            );
        return undefined;
    }
    await invalidateDirectory(client, parentDirectoryPath(restored.path));
    return restored.path;
}

/**
 * The rows coming back are the feedback, so they are selected and the last one is scrolled to like a pasted entry: a
 * restore into a long folder would otherwise land off-screen. Skipped when no Files tree is mounted for the restoring
 * Session.
 */
function revealRestoredPaths(paths: readonly string[]): void {
    const scope = activeResourceExplorerScope();
    const session = getSelectedSession();
    if (scope && session?.id === scope.sessionId)
        revealPathsInScope(scope.scopeId, session.rootPath, paths);
}

/**
 * Takes a Trash move back from the Undo button on its notification, which is already gone by then, so the restore
 * reports its own outcome.
 */
export async function didUndoTrashedFile(
    client: ResourceExplorerClient,
    undoToken: string,
    name: string,
): Promise<boolean> {
    const path = await restoreTrashedItem(client, undoToken, name);
    if (path === undefined) return false;
    revealRestoredPaths([path]);
    return true;
}

/**
 * Cmd+Z in the Files tree: takes back the latest Move to Trash of `sessionId` (every entry of a multi-selection Trash)
 * if no later file operation made it stale. Returns the Trash it took back, or `undefined` when there was nothing to
 * undo, so the caller only swallows the keystroke when it acted on it.
 */
export function undoLatestTrash(
    client: ResourceExplorerClient,
    sessionId: string,
): UndoableTrash | undefined {
    const trash = undoableTrashFor(sessionId);
    if (!trash) return undefined;
    /**
     * Claim the slot before the async restore: a second Cmd+Z (double press or key auto-repeat) would otherwise send
     * the same receipts again and show an error toast beside the success one. A name conflict is the one retryable
     * failure, so those receipts go back into the slot, unless a later operation already filled it.
     */
    forgetUndoableTrash();
    void (async () => {
        const restored: string[] = [];
        const conflicted: Array<UndoableTrash['items'][number]> = [];
        for (const item of trash.items) {
            // Sequential so two receipts for the same folder never race on its listing.
            // eslint-disable-next-line no-await-in-loop -- see above
            const path = await restoreTrashedItem(client, item.undoToken, item.name, () =>
                conflicted.push(item),
            );
            if (path !== undefined) restored.push(path);
        }
        revealRestoredPaths(restored);
        if (conflicted.length > 0 && !undoableTrashFor(trash.sessionId))
            rememberUndoableTrash({ items: conflicted, sessionId: trash.sessionId });
    })();
    return trash;
}

/**
 * Takes a Replace move back from the Undo button on its notification, in two steps that each report their own failure:
 * the moved file returns to its old folder first (freeing the name), then the overwritten file leaves the Trash for
 * that same name. A failed first step leaves the overwritten file in Trash with its receipt intact, so nothing is
 * lost.
 */
export async function didUndoReplacedMove(
    client: ResourceExplorerClient,
    undo: { name: string; path: string; previousPath: string; undoToken: string },
): Promise<boolean> {
    const restoredDirectory = parentDirectoryPath(undo.previousPath);
    const operationId = crypto.randomUUID();
    try {
        await client.move({
            operationId,
            path: undo.path,
            directory: restoredDirectory,
            conflict: 'reject',
        });
    } catch (error) {
        pushToast(
            'error',
            isCaxriError(error) && error.code === 'CONFLICT'
                ? translate('viewContainers.files.undoReplaceConflict', { name: undo.name })
                : describeFailureKey(error, 'viewContainers.files.moveFailed', translate),
        );
        await invalidateDirectory(client, restoredDirectory);
        return false;
    }
    const restored = await didUndoTrashedFile(client, undo.undoToken, undo.name);
    await invalidateDirectory(client, parentDirectoryPath(undo.path));
    await invalidateDirectory(client, restoredDirectory);
    return restored;
}
