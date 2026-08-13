import { errorMessage, isCaxriError, type MethodResult } from '@shared/ipc';
import type { MutableFileEntry } from '@shared/types';

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
import {
    reconcileFileMutation,
    waitForFileMutationReconciliation,
} from './file-operation-reconciliation';
import { useFileOperationStore } from './file-operation-state';
import { parentDirectoryPath } from './file-tree-refresh';

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
    propagateFailure?: boolean;
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
        else if (!(await waitForFileMutationReconciliation(options.id))) {
            useFileOperationStore.getState().finish(options.id);
            pushToast('error', 'File operation recovery is temporarily unavailable');
        }
        return result;
    } catch (error) {
        if (isCaxriError(error) && error.code === 'TIMEOUT') {
            const operation = await caxri
                .request('files.operation.cancel', { operationId: options.id })
                .catch(() => null);
            if (!operation) {
                if (!(await waitForFileMutationReconciliation(options.id)))
                    pushToast('error', 'File operation recovery is temporarily unavailable');
                return undefined;
            }
            if (operation.phase === 'staged') {
                await reconcileFileMutation(operation);
                pushToast('info', 'File change is still finishing safely in the background');
                return undefined;
            }
            await reconcileFileMutation(operation);
            if (options.propagateFailure)
                throw new Error(operation.error?.message ?? options.errorLabel, { cause: error });
            return undefined;
        }
        const operation = await caxri
            .request('files.operation.get', { operationId: options.id })
            .catch(() => null);
        if (operation?.phase === 'staged') {
            await reconcileFileMutation(operation);
            pushToast('info', 'File change is still finishing safely in the background');
            return undefined;
        }
        if (operation)
            await reconcileFileMutation(operation).catch(() => {
                pushToast('error', 'File operation recovery is temporarily unavailable');
            });
        else if (await waitForFileMutationReconciliation(options.id)) {
            if (options.propagateFailure) throw error;
            return undefined;
        } else {
            useFileOperationStore.getState().finish(options.id);
            if (!options.propagateFailure)
                pushToast('error', errorMessage(error, options.errorLabel));
        }
        if (options.propagateFailure) throw error;
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
        propagateFailure: true,
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
    if (kind === 'file' && getSelectedSession()?.id === sessionId) void openFile(created.path);
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
        propagateFailure: true,
        run: () => caxri.request('files.rename', { operationId, sessionId, path, name }),
    });
}

/**
 * Move-conflict policy is unified across every caller (drag-and-drop and cut-paste alike): a
 * same-name collision always rejects instead of silently auto-suffixing to "name copy". The
 * `files.move` contract only offers `reject`/`rename` — an interactive Replace/Keep Both/Cancel
 * choice would need a new IPC field this package is not authorized to add — so `reject` is the
 * simpler unified policy. It is also the one that already surfaces a clear, user-visible
 * explanation for free: the Runtime's `CONFLICT` error message ("A file or folder with that name
 * already exists") reaches the same error-toast path every failed mutation uses, so both drag-drop
 * and paste explain themselves identically instead of one throwing and the other silently renaming.
 */
export function moveFile(
    sessionId: string,
    path: string,
    directory: string,
    conflict: 'reject' | 'rename' = 'reject',
): Promise<MethodResult<'files.move'> | undefined> {
    const projectId = getSessionProjectId(sessionId) ?? `session:${sessionId}`;
    const operationId = crypto.randomUUID();
    return runDurableFileMutation({
        affectedPaths: [path, parentDirectoryPath(path), directory],
        errorLabel: 'Unable to move item',
        id: operationId,
        label: 'Moving item…',
        projectId,
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
 * User-triggered Cancel for a long-running durable mutation (create/rename/move). Mirrors the
 * internal timeout-driven cancel path in `runDurableFileMutation` above: Runtime's `staged` phase
 * cannot be rolled back safely (the file-system change already started), so a cancel that lands
 * after staging still reconciles to whatever Runtime finished with instead of pretending it stopped.
 */
export async function cancelFileOperation(operationId: string): Promise<void> {
    const operation = await caxri
        .request('files.operation.cancel', { operationId })
        .catch(() => null);
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
    const moved = await moveFile(sessionId, clipboard.path, directory, 'reject');
    if (moved) useFileClipboardStore.getState().clear();
    return moved;
}

export function duplicateFile(
    sessionId: string,
    path: string,
): Promise<MutableFileEntry | undefined> {
    return copyItem(sessionId, path, parentDirectoryPath(path));
}

export function revealFile(sessionId: string, path: string): Promise<null | undefined> {
    return tryCommand('Unable to reveal item in Finder', () =>
        caxri.request('files.reveal', { sessionId, path }),
    );
}

export function openFileInTerminal(directory: string): Promise<void> {
    return createTerminal('shell', false, directory);
}

export function copyFilePath(path: string, projectRoot?: string): Promise<void | undefined> {
    return tryCommand('Unable to copy path', async () => {
        const value = projectRoot ? projectRelativePath(path, projectRoot) : path;
        if (value === undefined) throw new Error('Path is outside the selected Project');
        await navigator.clipboard.writeText(value);
        pushToast('success', projectRoot ? 'Relative path copied' : 'Path copied');
    });
}

export async function trashFile(sessionId: string, path: string): Promise<boolean> {
    /**
     * Checked before the request so Main's confirmation copy can stop promising full
     * recoverability: Trash can only restore the last bytes written to disk, never an unsaved
     * buffer.
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
     * The user already confirmed this destructive action knowing changes were unsaved (the
     * `hasUnsavedChanges` copy above), but `closeOpenEditorsUnderPath` still discards those dirty
     * buffers without a trace. A persisted notice — like the external-write notice in
     * `external-sync.ts` — keeps that loss visible instead of vanishing with the success toast.
     */
    if (hasUnsavedChanges)
        pushToast(
            'info',
            `Unsaved changes to '${result.name}' were discarded; only the last saved version moved to Trash`,
            { persist: true },
        );
    return true;
}
