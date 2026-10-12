import type { FileEntry, MethodResult, MutableFileEntry } from '@caxri/protocol';
import { errorMessage, isCaxriError } from '@caxri/protocol';
import { pathBasename } from '@caxri/utils';

import { translate } from '../../../i18n';
import { parentDirectoryPath } from '../../../lib/file-path';
import { queryClient } from '../../../queries/client';
import { getSelectedSession, getSessionProjectId } from '../../../stores/selectors';
import { pushToast, tryCommand } from '../../../stores/toasts';
import { openFile } from '../../editor/document-commands';
import { closeOpenEditorsUnderPath, hasUnsavedChangesUnderPath } from '../../editor/document-trash';
import { isControlledViewOperationQuery } from '../view-operation-client';
import type { FileClipboardEntry } from './file-clipboard';
import { useFileClipboardStore } from './file-clipboard';
import { isFolderGatedConflict, requestFileConflictChoice } from './file-conflict-dialog-store';
import {
    clearFailureToastSuppression,
    didFileMutationReconcile,
    reconcileFileMutation,
    suppressFailureToast,
} from './file-operation-reconciliation';
import { useFileOperationStore } from './file-operation-state';
import type { ResourceExplorerClient } from './resource-explorer-client';

/**
 * Looks up one entry's kind from its directory listing; undefined when not found or unreadable.
 */
async function entryKind(
    client: ResourceExplorerClient,
    directory: string,
    name: string,
): Promise<FileEntry['kind'] | undefined> {
    let entries: FileEntry[];
    try {
        entries = await client.list(directory);
    } catch {
        entries = [];
    }
    return entries.find((entry) => entry.name === name)?.kind;
}

async function invalidateDirectory(
    client: ResourceExplorerClient,
    directory: string,
): Promise<void> {
    await queryClient.invalidateQueries({
        predicate: ({ queryKey }) =>
            isControlledViewOperationQuery(
                queryKey,
                client.viewId,
                'files.list',
                (arguments_) => arguments_.directory === directory,
            ),
    });
}

async function runTrackedFileOperation<Value>(options: {
    affectedPaths: readonly string[];
    errorLabel: string;
    id: string;
    label: string;
    projectId: string;
    run: () => Promise<Value>;
    successMessage: (result: Value) => string;
}): Promise<Value | undefined> {
    const operations = useFileOperationStore.getState();
    if (
        !operations.begin({
            id: options.id,
            label: options.label,
            projectId: options.projectId,
            affectedPaths: options.affectedPaths,
        })
    )
        return undefined;
    try {
        const result = await tryCommand(options.errorLabel, options.run);
        if (result !== undefined) pushToast('success', options.successMessage(result));
        return result;
    } finally {
        useFileOperationStore.getState().finish(options.id);
    }
}

/**
 * With `shouldPropagateFailure`, the caller owns explaining a failure (inline create/rename error, move conflict
 * prompt), so the failed operation's reconciliation must not toast the same failure a second time. The suppression is
 * registered before the request and always cleared once this call settles; the failed branch below awaits
 * reconciliation first, so the registration is still in place when reconciliation decides whether to toast.
 */
async function runDurableFileMutation<Value>(options: {
    affectedPaths: readonly string[];
    errorLabel: string;
    id: string;
    label: string;
    projectId: string;
    shouldPropagateFailure?: boolean;
    client: ResourceExplorerClient;
    run: () => Promise<Value>;
}): Promise<Value | undefined> {
    const store = useFileOperationStore.getState();
    if (
        !store.begin({
            id: options.id,
            label: options.label,
            projectId: options.projectId,
            affectedPaths: options.affectedPaths,
            cancelable: true,
        })
    )
        return undefined;
    if (options.shouldPropagateFailure) suppressFailureToast(options.id);
    try {
        return await runDurableFileMutationAttempt(options);
    } finally {
        if (options.shouldPropagateFailure) clearFailureToastSuppression(options.id);
    }
}

async function runDurableFileMutationAttempt<Value>(options: {
    errorLabel: string;
    id: string;
    shouldPropagateFailure?: boolean;
    client: ResourceExplorerClient;
    run: () => Promise<Value>;
}): Promise<Value | undefined> {
    try {
        const result = await options.run();
        const operation = await options.client.getOperation(options.id);
        if (operation) await reconcileFileMutation(options.client, operation);
        else if (!(await didFileMutationReconcile(options.id))) {
            useFileOperationStore.getState().finish(options.id);
            pushToast('error', translate('viewContainers.files.recoveryUnavailable'));
        }
        return result;
    } catch (error) {
        if (isCaxriError(error) && error.code === 'TIMEOUT') {
            let operation: MethodResult<'files.operation.cancel'> | null;
            try {
                operation = await options.client.cancelOperation(options.id);
            } catch {
                operation = null;
            }
            if (!operation) {
                if (!(await didFileMutationReconcile(options.id)))
                    pushToast('error', translate('viewContainers.files.recoveryUnavailable'));
                return undefined;
            }
            if (operation.phase === 'staged') {
                await reconcileFileMutation(options.client, operation);
                pushToast('info', translate('viewContainers.files.stillFinishing'));
                return undefined;
            }
            await reconcileFileMutation(options.client, operation);
            if (options.shouldPropagateFailure)
                throw new Error(operation.error?.message ?? options.errorLabel, { cause: error });
            return undefined;
        }
        let operation: MethodResult<'files.operation.get'> | null;
        try {
            operation = await options.client.getOperation(options.id);
        } catch {
            operation = null;
        }
        if (operation?.phase === 'staged') {
            await reconcileFileMutation(options.client, operation);
            pushToast('info', translate('viewContainers.files.stillFinishing'));
            return undefined;
        }
        if (operation) {
            try {
                await reconcileFileMutation(options.client, operation);
            } catch {
                pushToast('error', translate('viewContainers.files.recoveryUnavailable'));
            }
        } else if (await didFileMutationReconcile(options.id)) {
            if (options.shouldPropagateFailure) throw error;
            return undefined;
        } else {
            useFileOperationStore.getState().finish(options.id);
            if (!options.shouldPropagateFailure)
                pushToast('error', errorMessage(error, options.errorLabel));
        }
        if (options.shouldPropagateFailure) throw error;
        return undefined;
    }
}

export async function createItem(
    client: ResourceExplorerClient,
    sessionId: string,
    directory: string,
    name: string,
    kind: 'file' | 'directory',
): Promise<MutableFileEntry | undefined> {
    const operationId = crypto.randomUUID();
    const projectId = getSessionProjectId(sessionId) ?? `session:${sessionId}`;
    const created = await runDurableFileMutation({
        affectedPaths: [directory],
        errorLabel: translate('viewContainers.files.createFailed'),
        id: operationId,
        label: translate('viewContainers.files.creating'),
        projectId,
        shouldPropagateFailure: true,
        client,
        run: () => client.create({ operationId, directory, name, kind }),
    });
    if (!created) return undefined;
    if (kind === 'file' && getSelectedSession()?.id === sessionId) {
        // openFile funnels its own failures into a toast via tryCommand, nothing to await here.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void openFile(created.path);
    }
    return created;
}

function copyItem(
    client: ResourceExplorerClient,
    sessionId: string,
    path: string,
    directory: string,
): Promise<MutableFileEntry | undefined> {
    const projectId = getSessionProjectId(sessionId) ?? `session:${sessionId}`;
    return runTrackedFileOperation({
        affectedPaths: [directory],
        errorLabel: translate('viewContainers.files.copyFailed'),
        id: JSON.stringify(['copy', projectId, path, directory]),
        label: translate('viewContainers.files.copying'),
        projectId,
        successMessage: (copied) => translate('viewContainers.files.copied', { name: copied.name }),
        run: async () => {
            const copied = await client.copy(path, directory);
            await invalidateDirectory(client, directory);
            return copied;
        },
    });
}

export async function renameFile(
    client: ResourceExplorerClient,
    sessionId: string,
    path: string,
    name: string,
): Promise<MethodResult<'files.rename'> | undefined> {
    const operationId = crypto.randomUUID();
    const projectId = getSessionProjectId(sessionId) ?? `session:${sessionId}`;
    return runDurableFileMutation({
        affectedPaths: [path, parentDirectoryPath(path)],
        errorLabel: translate('viewContainers.files.renameFailed'),
        id: operationId,
        label: translate('viewContainers.files.renaming'),
        projectId,
        shouldPropagateFailure: true,
        client,
        run: () => client.rename({ operationId, path, name }),
    });
}

/**
 * Runs one `files.move` attempt under a fresh operation id.
 */
function attemptMove(
    client: ResourceExplorerClient,
    sessionId: string,
    path: string,
    directory: string,
    conflict: 'reject' | 'rename' | 'replace',
    shouldPropagateFailure: boolean,
): Promise<MethodResult<'files.move'> | undefined> {
    const operationId = crypto.randomUUID();
    const projectId = getSessionProjectId(sessionId) ?? `session:${sessionId}`;
    return runDurableFileMutation({
        affectedPaths: [path, parentDirectoryPath(path), directory],
        errorLabel: translate('viewContainers.files.moveFailed'),
        id: operationId,
        label: translate('viewContainers.files.moving'),
        projectId,
        shouldPropagateFailure,
        client,
        run: () => client.move({ operationId, path, directory, conflict }),
    });
}

/**
 * Every move call site (drag-and-drop in the file tree, drop on the panel root, cut-paste on a row, cut-paste on the
 * root) funnels through this single interactive orchestrator instead of each one choosing its own conflict policy.
 *
 * The first attempt always uses `reject`, and this function (not reconciliation) owns explaining whatever that attempt
 * fails with: `shouldPropagateFailure: true` makes the rejection reach this `catch` instead of
 * `runDurableFileMutation`'s own error-toast path, and keeps reconciliation from toasting the same failure again.
 *
 * A `CONFLICT` opens a Finder-style Replace/Keep Both/Cancel prompt (`file-conflict-dialog.ts`) instead of a toast.
 * Availability of Replace is gated on both sides of the collision actually being plain files, fetched fresh via
 * `files.list` (Server can only atomically overwrite a file target, never a folder; see `assertReplaceableMove` in
 * `mutations.ts`). Replace retries with `conflict: 'replace'`; Keep Both retries with `conflict: 'rename'` (the
 * existing auto-suffix "name copy" behavior); Cancel resolves with no retry and no toast, leaving a cut clipboard entry
 * armed for another attempt elsewhere. Every retry is a fresh, unregistered operation id on the normal
 * (non-propagating) toast path, so its own success or failure explains itself the same way any other file mutation
 * does.
 *
 * Any non-`CONFLICT` failure from the first attempt is not retried or dialoged: reconciliation stays silent for the
 * registered id (see `file-operation-reconciliation.ts`), and this function toasts it exactly once itself before
 * returning `undefined`, preserving the pre-existing single-toast behavior for every other error instead of doubling it
 * up.
 *
 * In-place rename (`renameFile` below) deliberately keeps its non-interactive inline CONFLICT error instead of this
 * prompt: it edits a single row in place, and a modal dialog over one text field would be disproportionate chrome for a
 * collision the user can just retype.
 */
export async function moveFile(
    client: ResourceExplorerClient,
    sessionId: string,
    path: string,
    directory: string,
): Promise<MethodResult<'files.move'> | undefined> {
    try {
        return await attemptMove(client, sessionId, path, directory, 'reject', true);
    } catch (error) {
        if (!isCaxriError(error) || error.code !== 'CONFLICT') {
            pushToast('error', errorMessage(error, translate('viewContainers.files.moveFailed')));
            return undefined;
        }
        const name = pathBasename(path);
        const [targetKind, sourceKind] = await Promise.all([
            entryKind(client, directory, name),
            entryKind(client, parentDirectoryPath(path), name),
        ]);
        const choice = await requestFileConflictChoice({
            name,
            folderGated: isFolderGatedConflict(sourceKind, targetKind),
        });
        if (choice === 'cancel') return undefined;
        return attemptMove(
            client,
            sessionId,
            path,
            directory,
            choice === 'replace' ? 'replace' : 'rename',
            false,
        );
    }
}

/**
 * User-triggered Cancel for a long-running durable mutation (create/rename/move). Mirrors the internal timeout-driven
 * cancel path in `runDurableFileMutation` above: Server's `staged` phase cannot be rolled back safely (the file-system
 * change already started), so a cancel that lands after staging still reconciles to whatever Server finished with
 * instead of pretending it stopped.
 */
export async function cancelFileOperation(
    client: ResourceExplorerClient,
    operationId: string,
): Promise<void> {
    let operation: MethodResult<'files.operation.cancel'> | null;
    try {
        operation = await client.cancelOperation(operationId);
    } catch {
        operation = null;
    }
    if (!operation) {
        pushToast('error', translate('viewContainers.files.cancelFailed'));
        return;
    }
    if (operation.phase === 'staged')
        pushToast('info', translate('viewContainers.files.stillFinishing'));
    await reconcileFileMutation(client, operation);
}

export function rememberFile(
    projectId: string,
    path: string,
    mode: FileClipboardEntry['mode'],
): void {
    useFileClipboardStore.getState().set({ mode, path, projectId });
    pushToast(
        'info',
        translate(
            mode === 'cut'
                ? 'viewContainers.files.readyToMove'
                : 'viewContainers.files.readyToCopy',
        ),
    );
}

export async function pasteFile(
    client: ResourceExplorerClient,
    sessionId: string,
    projectId: string,
    directory: string,
    clipboard: FileClipboardEntry,
): Promise<MutableFileEntry | MethodResult<'files.move'> | undefined> {
    if (clipboard.projectId !== projectId) {
        pushToast('error', translate('viewContainers.files.pasteOtherProject'));
        return undefined;
    }
    if (clipboard.mode === 'copy') return copyItem(client, sessionId, clipboard.path, directory);
    const moved = await moveFile(client, sessionId, clipboard.path, directory);
    if (moved) useFileClipboardStore.getState().clear();
    return moved;
}

export function duplicateFile(
    client: ResourceExplorerClient,
    sessionId: string,
    path: string,
): Promise<MutableFileEntry | undefined> {
    return copyItem(client, sessionId, path, parentDirectoryPath(path));
}

export async function didTrashFile(
    client: ResourceExplorerClient,
    sessionId: string,
    path: string,
): Promise<boolean> {
    /**
     * Resolved once, before the confirmation, and reused for the cleanup afterwards. A Session can change its Workbench
     * Root while the dialog is open: an Agent creating a worktree does it with no user action under
     * `workbench.newWorktreeBehavior: continueAutomatically`, and re-deriving it after the await would clean a
     * different root than the one the user was asked about.
     */
    const workbenchProjectId = getSessionProjectId(sessionId);
    if (!workbenchProjectId) return false;
    /**
     * Checked before the request so Main's confirmation copy can stop promising full recoverability: Trash can only
     * restore the last bytes written to disk, never an unsaved buffer.
     */
    const hasUnsavedChanges = hasUnsavedChangesUnderPath(workbenchProjectId, path);
    const result = await tryCommand(translate('viewContainers.files.trashFailed'), () =>
        client.trash(path, { hasUnsavedChanges }),
    );
    if (!result || 'canceled' in result) return false;
    closeOpenEditorsUnderPath(workbenchProjectId, result.path);
    /**
     * Only this root's pane layout is in memory, so the call above cannot reach a Session parked on another root. Its
     * layout for this root lives on the Server, and a tab left there reopens stuck on `Loading file…` (issue #909).
     */
    await tryCommand(translate('viewContainers.files.trashCleanupFailed'), () =>
        client.forgetEditorPath(workbenchProjectId, result.path),
    );
    await invalidateDirectory(client, parentDirectoryPath(result.path));
    /**
     * One persistent card keeps the confirmed loss of unsaved edits visible without duplicating success feedback. It is
     * a warning when edits were lost: the move succeeded, but the user should not read the card as all-clear.
     */
    pushToast(
        hasUnsavedChanges ? 'warning' : 'success',
        translate(
            hasUnsavedChanges
                ? 'viewContainers.files.trashedUnsaved'
                : 'viewContainers.files.trashed',
            { name: result.name },
        ),
        { persist: hasUnsavedChanges },
    );
    return true;
}
