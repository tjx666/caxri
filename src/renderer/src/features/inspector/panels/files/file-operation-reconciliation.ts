import { useEffect } from 'react';

import type { FileMutationOperation } from '@shared/types';

import { caxri } from '../../../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../../../queries/client';
import { getProjectSessionIds, getSessionProjectId } from '../../../../stores/selectors';
import { pushToast } from '../../../../stores/toasts';
import { remapOpenEditorsDurably } from '../../../editor/document-actions';
import { useFileOperationStore } from './file-operation-state';
import { parentDirectoryPath } from './file-tree-refresh';

const reconciling = new Map<string, Promise<void>>();
const reconciled = new Set<string>();
const retrying = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>();
const MAXIMUM_REMEMBERED_RECONCILIATIONS = 256;
const RECONCILIATION_RETRY_BASE_MS = 250;
const MAXIMUM_RECONCILIATION_RETRY_MS = 30_000;

function rememberReconciliation(operationId: string): void {
    const retry = retrying.get(operationId);
    if (retry) clearTimeout(retry.timer);
    retrying.delete(operationId);
    reconciled.add(operationId);
    if (reconciled.size <= MAXIMUM_REMEMBERED_RECONCILIATIONS) return;
    const oldest = reconciled.values().next().value;
    if (oldest) reconciled.delete(oldest);
}

function scheduleReconciliationRetry(operation: FileMutationOperation): void {
    const previous = retrying.get(operation.id);
    if (previous) clearTimeout(previous.timer);
    else pushToast('info', 'File change is still synchronizing in the background');
    const attempt = (previous?.attempt ?? 0) + 1;
    const delay = Math.min(
        RECONCILIATION_RETRY_BASE_MS * 2 ** (attempt - 1),
        MAXIMUM_RECONCILIATION_RETRY_MS,
    );
    const timer = setTimeout(() => {
        void reconcileFileMutation(operation).catch(() => {
            // The failed attempt schedules its own bounded-backoff retry.
        });
    }, delay);
    retrying.set(operation.id, { attempt, timer });
}

function operationLabel(operation: FileMutationOperation): string {
    const action =
        operation.kind === 'create'
            ? 'Creating item'
            : operation.kind === 'rename'
              ? 'Renaming item'
              : 'Moving item';
    return operation.phase === 'staged' ? `${action} in background…` : `${action}…`;
}

function operationSuccess(operation: FileMutationOperation): string {
    if (operation.kind === 'create') return 'Item created';
    if (operation.kind === 'rename') return 'Item renamed';
    return 'Item moved';
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

async function applyCompletedOperation(operation: FileMutationOperation): Promise<void> {
    if (!operation.result) throw new Error('Completed file operation has no result');
    if (operation.kind === 'create') {
        await invalidateDirectory(operation.sessionId, operation.input.directory);
        return;
    }
    await remapOpenEditorsDurably(
        operation.sessionId,
        operation.id,
        operation.result.previousPath,
        operation.result.path,
    );
    const directories = [parentDirectoryPath(operation.result.previousPath)];
    if (operation.kind === 'move') directories.push(operation.input.directory);
    await Promise.all(
        [...new Set(directories)].map((directory) =>
            invalidateDirectory(operation.sessionId, directory),
        ),
    );
}

async function invalidateAffectedDirectories(operation: FileMutationOperation): Promise<void> {
    if (operation.kind === 'create') {
        await invalidateDirectory(operation.sessionId, operation.input.directory);
        return;
    }
    const directories = new Set([parentDirectoryPath(operation.input.path)]);
    if (operation.kind === 'move') directories.add(operation.input.directory);
    if (operation.expectedResult)
        directories.add(parentDirectoryPath(operation.expectedResult.path));
    await Promise.all(
        [...directories].map((directory) => invalidateDirectory(operation.sessionId, directory)),
    );
}

/** Applies each durable result before acknowledging it, making window recovery safely at-least-once. */
export function reconcileFileMutation(operation: FileMutationOperation): Promise<void> {
    if (reconciled.has(operation.id)) return Promise.resolve();
    const existing = reconciling.get(operation.id);
    if (existing) return existing;
    const projectId = getSessionProjectId(operation.sessionId) ?? `session:${operation.sessionId}`;
    const store = useFileOperationStore.getState();
    store.begin({ id: operation.id, label: operationLabel(operation), projectId });
    store.update(operation.id, operationLabel(operation));
    if (operation.phase === 'pre_stage' || operation.phase === 'staged') return Promise.resolve();

    const reconciliation = (async () => {
        if (operation.phase === 'completed') {
            await applyCompletedOperation(operation);
        } else {
            await invalidateAffectedDirectories(operation);
        }
        await caxri.request('files.operation.acknowledge', { operationId: operation.id });
        useFileOperationStore.getState().finish(operation.id);
        rememberReconciliation(operation.id);
        if (operation.phase === 'completed') pushToast('success', operationSuccess(operation));
        else
            pushToast('error', operation.error?.message ?? 'File operation could not be completed');
    })()
        .catch(() => {
            /** Runtime keeps the durable result until every same-Project Session remap and ack
             *  succeeds, so a transient persistence failure must retry across Renderer reloads. */
            scheduleReconciliationRetry(operation);
        })
        .finally(() => reconciling.delete(operation.id));
    reconciling.set(operation.id, reconciliation);
    return reconciliation;
}

/** Lets the initiating action join an event-driven reconciliation that won the IPC response race. */
export async function waitForFileMutationReconciliation(operationId: string): Promise<boolean> {
    await reconciling.get(operationId)?.catch(() => undefined);
    return reconciled.has(operationId);
}

async function loadFileMutations(): Promise<void> {
    const operations = await caxri.request('files.operation.list');
    await Promise.all(operations.map((operation) => reconcileFileMutation(operation)));
}

/** Restores pending/final mutation state after a Renderer reload and after every Runtime restart. */
export function useFileMutationReconciliation(active: boolean): void {
    useEffect(() => {
        if (!active) return;
        void loadFileMutations().catch(() => {
            pushToast('error', 'File operation recovery is temporarily unavailable');
        });
        return caxri.onEvent((event) => {
            if (event.event === 'files.operationChanged')
                void reconcileFileMutation(event.payload).catch(() => {
                    pushToast('error', 'File operation recovery is temporarily unavailable');
                });
            if (event.event === 'runtime.status' && event.payload.status === 'ready')
                void loadFileMutations().catch(() => {
                    pushToast('error', 'File operation recovery is temporarily unavailable');
                });
        });
    }, [active]);
}
