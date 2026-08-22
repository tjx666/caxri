import { pathBasename } from '@caxri/utils';
import type { MethodResult } from '@shared/ipc';
import { errorMessage, isCaxriError } from '@shared/ipc';
import type { FileEntry, MutableFileEntry } from '@shared/types';

import { caxri } from '../../../../lib/caxri';
import { projectRelativePath } from '../../../../lib/file-path';
import { caxriQueryKey, queryClient } from '../../../../queries/client';
import {
    getProjectSessionIds,
    getSelectedSession,
    getSessionProjectId,
} from '../../../../stores/selectors';
import { pushToast, tryCommand } from '../../../../stores/toasts';
import {
    closeOpenEditorsUnderPath,
    hasUnsavedChangesUnderPath,
    openFile,
} from '../../../editor/document-actions';
import { createTerminal } from '../../../terminal/terminal-actions';
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
import { parentDirectoryPath } from './file-tree-refresh';

/**
 * Looks up one entry's kind from its directory listing; undefined when not found or unreadable.
 */
async function entryKind(
    sessionId: string,
    directory: string,
    name: string,
): Promise<FileEntry['kind'] | undefined> {
    let entries: FileEntry[];
    try {
        entries = await caxri.request('files.list', { sessionId, directory });
    } catch {
        entries = [];
    }
    return entries.find((entry) => entry.name === name)?.kind;
}

async function invalidateDirectory(sessionId: string, directory: string): Promise<void> {
    await Promise.all(
        getProjectSessionIds(sessionId).map((projectSessionId) =>
            queryClient.invalidateQueries({
                queryKey: caxriQueryKey('files.list', {
                    sessionId: projectSessionId,
                    directory,
                }),
            }),
        ),
    );
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

async function runDurableFileMutation<Value>(options: {
    affectedPaths: readonly string[];
    errorLabel: string;
    id: string;
    label: string;
    projectId: string;
    shouldPropagateFailure?: boolean;
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
    try {
        const result = await options.run();
        const operation = await caxri.request('files.operation.get', {
            operationId: options.id,
        });
        if (operation) await reconcileFileMutation(operation);
        else if (!(await didFileMutationReconcile(options.id))) {
            useFileOperationStore.getState().finish(options.id);
            pushToast('error', 'File operation recovery is temporarily unavailable');
        }
        return result;
    } catch (error) {
        if (isCaxriError(error) && error.code === 'TIMEOUT') {
            let operation: MethodResult<'files.operation.cancel'> | null;
            try {
                operation = await caxri.request('files.operation.cancel', {
                    operationId: options.id,
                });
            } catch {
                operation = null;
            }
            if (!operation) {
                if (!(await didFileMutationReconcile(options.id)))
                    pushToast('error', 'File operation recovery is temporarily unavailable');
                return undefined;
            }
            if (operation.phase === 'staged') {
                await reconcileFileMutation(operation);
                pushToast('info', 'File change is still finishing safely in the background');
                return undefined;
            }
            await reconcileFileMutation(operation);
            if (options.shouldPropagateFailure)
                throw new Error(operation.error?.message ?? options.errorLabel, { cause: error });
            return undefined;
        }
        let operation: MethodResult<'files.operation.get'> | null;
        try {
            operation = await caxri.request('files.operation.get', { operationId: options.id });
        } catch {
            operation = null;
        }
        if (operation?.phase === 'staged') {
            await reconcileFileMutation(operation);
            pushToast('info', 'File change is still finishing safely in the background');
            return undefined;
        }
        if (operation) {
            try {
                await reconcileFileMutation(operation);
            } catch {
                pushToast('error', 'File operation recovery is temporarily unavailable');
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
    sessionId: string,
    directory: string,
    name: string,
    kind: 'file' | 'directory',
): Promise<MutableFileEntry | undefined> {
    const operationId = crypto.randomUUID();
    const projectId = getSessionProjectId(sessionId) ?? `session:${sessionId}`;
    const created = await runDurableFileMutation({
        affectedPaths: [directory],
        errorLabel: 'Unable to create item',
        id: operationId,
        label: 'Creating item…',
        projectId,
        shouldPropagateFailure: true,
        run: () =>
            caxri.request('files.create', {
                operationId,
                sessionId,
                directory,
                name,
                kind,
            }),
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
    sessionId: string,
    path: string,
    directory: string,
): Promise<MutableFileEntry | undefined> {
    const projectId = getSessionProjectId(sessionId) ?? `session:${sessionId}`;
    return runTrackedFileOperation({
        affectedPaths: [directory],
        errorLabel: 'Unable to copy item',
        id: JSON.stringify(['copy', projectId, path, directory]),
        label: 'Copying item…',
        projectId,
        successMessage: (copied) => `'${copied.name}' copied`,
        run: async () => {
            const copied = await caxri.request('files.copy', { sessionId, path, directory });
            await invalidateDirectory(sessionId, directory);
            return copied;
        },
    });
}

export async function renameFile(
    sessionId: string,
    path: string,
    name: string,
): Promise<MethodResult<'files.rename'> | undefined> {
    const operationId = crypto.randomUUID();
    const projectId = getSessionProjectId(sessionId) ?? `session:${sessionId}`;
    return runDurableFileMutation({
        affectedPaths: [path, parentDirectoryPath(path)],
        errorLabel: 'Unable to rename item',
        id: operationId,
        label: 'Renaming item…',
        projectId,
        shouldPropagateFailure: true,
        run: () => caxri.request('files.rename', { operationId, sessionId, path, name }),
    });
}

/**
 * Runs one `files.move` attempt. `operationId` defaults to a fresh id, but the propagating first attempt in `moveFile`
 * below passes its own id in so it can register/clear failure-toast suppression around the call (see
 * `suppressFailureToast` in `file-operation-reconciliation.ts`) — `attemptMove` itself owns none of that handshake,
 * only the request/tracking plumbing.
 */
function attemptMove(
    sessionId: string,
    path: string,
    directory: string,
    conflict: 'reject' | 'rename' | 'replace',
    shouldPropagateFailure: boolean,
    operationId: string = crypto.randomUUID(),
): Promise<MethodResult<'files.move'> | undefined> {
    const projectId = getSessionProjectId(sessionId) ?? `session:${sessionId}`;
    return runDurableFileMutation({
        affectedPaths: [path, parentDirectoryPath(path), directory],
        errorLabel: 'Unable to move item',
        id: operationId,
        label: 'Moving item…',
        projectId,
        shouldPropagateFailure,
        run: () =>
            caxri.request('files.move', {
                operationId,
                sessionId,
                path,
                directory,
                conflict,
            }),
    });
}

/**
 * Every move call site (drag-and-drop in the file tree, drop on the panel root, cut-paste on a row, cut-paste on the
 * root) funnels through this single interactive orchestrator instead of each one choosing its own conflict policy.
 *
 * The first attempt always uses `reject`, and this function — not reconciliation — owns explaining whatever that
 * attempt fails with. It generates that attempt's operation id itself, registers it with `suppressFailureToast` before
 * calling `attemptMove` (`shouldPropagateFailure: true` makes the rejection reach this `catch` instead of
 * `runDurableFileMutation`'s own error-toast path), and always clears the registration in `finally` via
 * `clearFailureToastSuppression` — on success, on a `CONFLICT`, on any other failure, and even if the failed operation
 * never makes it back through `reconcileFileMutation` at all, so the registry entry can never outlive this call.
 *
 * A `CONFLICT` opens a Finder-style Replace/Keep Both/Cancel prompt (`file-conflict-dialog.ts`) instead of a toast.
 * Availability of Replace is gated on both sides of the collision actually being plain files, fetched fresh via
 * `files.list` (Runtime can only atomically overwrite a file target, never a folder; see `assertReplaceableMove` in
 * `mutations.ts`). Replace retries with `conflict: 'replace'`; Keep Both retries with `conflict: 'rename'` (the
 * existing auto-suffix "name copy" behavior); Cancel resolves with no retry and no toast, leaving a cut clipboard entry
 * armed for another attempt elsewhere. Every retry is a fresh, unregistered operation id on the normal
 * (non-propagating) toast path, so its own success or failure explains itself the same way any other file mutation
 * does.
 *
 * Any non-`CONFLICT` failure from the first attempt is not retried or dialoged: reconciliation stays silent for the
 * registered id (see `file-operation-reconciliation.ts`), and this function toasts it exactly once itself before
 * returning `undefined` — preserving the pre-existing single-toast behavior for every other error instead of doubling
 * it up.
 *
 * In-place rename (`renameFile` below) deliberately keeps its non-interactive inline CONFLICT error instead of this
 * prompt: it edits a single row in place, and a modal dialog over one text field would be disproportionate chrome for a
 * collision the user can just retype.
 */
export async function moveFile(
    sessionId: string,
    path: string,
    directory: string,
): Promise<MethodResult<'files.move'> | undefined> {
    const operationId = crypto.randomUUID();
    suppressFailureToast(operationId);
    try {
        return await attemptMove(sessionId, path, directory, 'reject', true, operationId);
    } catch (error) {
        if (!isCaxriError(error) || error.code !== 'CONFLICT') {
            pushToast('error', errorMessage(error, 'Unable to move item'));
            return undefined;
        }
        const name = pathBasename(path);
        const [targetKind, sourceKind] = await Promise.all([
            entryKind(sessionId, directory, name),
            entryKind(sessionId, parentDirectoryPath(path), name),
        ]);
        const choice = await requestFileConflictChoice({
            name,
            folderGated: isFolderGatedConflict(sourceKind, targetKind),
        });
        if (choice === 'cancel') return undefined;
        // Awaited so `finally` clears the failure-toast suppression only after this retry settles, not before it.
        return await attemptMove(
            sessionId,
            path,
            directory,
            choice === 'replace' ? 'replace' : 'rename',
            false,
        );
    } finally {
        clearFailureToastSuppression(operationId);
    }
}

/**
 * User-triggered Cancel for a long-running durable mutation (create/rename/move). Mirrors the internal timeout-driven
 * cancel path in `runDurableFileMutation` above: Runtime's `staged` phase cannot be rolled back safely (the file-system
 * change already started), so a cancel that lands after staging still reconciles to whatever Runtime finished with
 * instead of pretending it stopped.
 */
export async function cancelFileOperation(operationId: string): Promise<void> {
    let operation: MethodResult<'files.operation.cancel'> | null;
    try {
        operation = await caxri.request('files.operation.cancel', { operationId });
    } catch {
        operation = null;
    }
    if (!operation) {
        pushToast('error', 'Unable to cancel item operation');
        return;
    }
    if (operation.phase === 'staged')
        pushToast('info', 'File change is still finishing safely in the background');
    await reconcileFileMutation(operation);
}

export function rememberFile(
    projectId: string,
    path: string,
    mode: FileClipboardEntry['mode'],
): void {
    useFileClipboardStore.getState().set({ mode, path, projectId });
    pushToast('info', mode === 'cut' ? 'Ready to move item' : 'Ready to copy item');
}

export async function pasteFile(
    sessionId: string,
    projectId: string,
    directory: string,
    clipboard: FileClipboardEntry,
): Promise<MutableFileEntry | MethodResult<'files.move'> | undefined> {
    if (clipboard.projectId !== projectId) {
        pushToast('error', 'Files can only be pasted inside the same Project');
        return undefined;
    }
    if (clipboard.mode === 'copy') return copyItem(sessionId, clipboard.path, directory);
    const moved = await moveFile(sessionId, clipboard.path, directory);
    if (moved) useFileClipboardStore.getState().clear();
    return moved;
}

export function duplicateFile(
    sessionId: string,
    path: string,
): Promise<MutableFileEntry | undefined> {
    return copyItem(sessionId, path, parentDirectoryPath(path));
}

export function revealFile(sessionId: string, path: string): Promise<void | undefined> {
    return tryCommand('Unable to reveal item in Finder', async () => {
        await caxri.request('files.reveal', { sessionId, path });
    });
}

export function openFileInTerminal(directory: string): Promise<void> {
    return createTerminal('shell', { cwd: directory });
}

export function copyFilePath(path: string, projectRoot?: string): Promise<void | undefined> {
    return tryCommand('Unable to copy path', async () => {
        const value = projectRoot ? projectRelativePath(path, projectRoot) : path;
        if (value === undefined) throw new Error('Path is outside the selected Project');
        await navigator.clipboard.writeText(value);
        pushToast('success', projectRoot ? 'Relative path copied' : 'Path copied');
    });
}

export async function didTrashFile(sessionId: string, path: string): Promise<boolean> {
    /**
     * Checked before the request so Main's confirmation copy can stop promising full recoverability: Trash can only
     * restore the last bytes written to disk, never an unsaved buffer.
     */
    const hasUnsavedChanges = hasUnsavedChangesUnderPath(sessionId, path);
    const result = await tryCommand('Unable to move item to Trash', () =>
        caxri.request('files.trash', { sessionId, path, hasUnsavedChanges }),
    );
    if (!result || 'canceled' in result) return false;
    closeOpenEditorsUnderPath(sessionId, result.path);
    await invalidateDirectory(sessionId, parentDirectoryPath(result.path));
    pushToast('success', `Moved '${result.name}' to Trash`);
    /**
     * The user already confirmed this destructive action knowing changes were unsaved (the `hasUnsavedChanges` copy
     * above), but `closeOpenEditorsUnderPath` still discards those dirty buffers without a trace. A persisted notice —
     * like the external-write notice in `external-sync.ts` — keeps that loss visible instead of vanishing with the
     * success toast.
     */
    if (hasUnsavedChanges)
        pushToast(
            'info',
            `Unsaved changes to '${result.name}' were discarded; only the last saved version moved to Trash`,
            { persist: true },
        );
    return true;
}
