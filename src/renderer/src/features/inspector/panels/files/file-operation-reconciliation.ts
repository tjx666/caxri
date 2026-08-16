import { useEffect } from 'react';

import type { FileMutationOperation } from '@shared/types';

import { caxri } from '../../../../lib/caxri';
import { caxriQueryKey, queryClient } from '../../../../queries/client';
import {
    getSessionOwnerProjectId,
    getWorkbenchProjectSessionIds,
} from '../../../../stores/selectors';
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

/**
 * Operation ids whose failure toast `reconcileFileMutation` must skip entirely, because the caller that started the
 * operation already owns explaining that specific failure itself. The one current user is `file-actions.ts`'s
 * `moveFile`: it registers its first (`reject`-mode) attempt's id before starting, and its own `try`/`catch` decides
 * how to explain any failure — open the interactive Replace/Keep Both/Cancel dialog for `CONFLICT`, or toast once for
 * anything else — so reconciliation must stay silent for that id regardless of the error code, or the caller's message
 * would double up with reconciliation's own. Everything else about reconciliation (acknowledge, store finish, directory
 * invalidation) still runs unconditionally for a suppressed id — only the toast is skipped, and only once per
 * registration (see `didConsumeFailureToastSuppression`). The registration is cleared in the caller's own `finally`
 * (see `clearFailureToastSuppression`) so a successful or never-reconciled operation can't leak an entry either. A
 * Renderer reload mid-flight loses this in-memory registry, so a suppressed operation that somehow reaches
 * `reconcileFileMutation` again only after a reload falls back to the normal toast; that is an acceptable rare edge
 * case, not a durable guarantee.
 */
const failureToastSuppressed = new Set<string>();

/**
 * Registers an operation's failure toast as owned by its caller instead of reconciliation.
 */
export function suppressFailureToast(operationId: string): void {
    failureToastSuppressed.add(operationId);
}

/**
 * Releases a registration without regard to whether reconciliation ever consumed it. The caller that registered the id
 * calls this from its own `finally`, so a move that succeeds, or one whose failed operation never reaches
 * `reconcileFileMutation` at all, cannot leak the entry forever.
 */
export function clearFailureToastSuppression(operationId: string): void {
    failureToastSuppressed.delete(operationId);
}

/**
 * Consumes a registered suppression; true means the failure toast below must be skipped.
 */
function didConsumeFailureToastSuppression(operationId: string): boolean {
    return failureToastSuppressed.delete(operationId);
}

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
        // Fire-and-forget: a failed attempt here schedules its own bounded-backoff retry, so
        // there is nothing further to await.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void (async (): Promise<void> => {
            try {
                await reconcileFileMutation(operation);
            } catch {
                // The failed attempt schedules its own bounded-backoff retry.
            }
        })();
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
    const name = operation.result?.name ?? 'Item';
    if (operation.kind === 'create') return `'${name}' created`;
    if (operation.kind === 'rename') return `Renamed to '${name}'`;
    return `'${name}' moved`;
}

/**
 * Mirrors the affected-subtree scoping `file-actions.ts` uses when it first starts an operation.
 */
function operationAffectedPaths(operation: FileMutationOperation): string[] {
    if (operation.kind === 'create') return [operation.input.directory];
    if (operation.kind === 'rename')
        return [operation.input.path, parentDirectoryPath(operation.input.path)];
    return [
        operation.input.path,
        parentDirectoryPath(operation.input.path),
        operation.input.directory,
    ];
}

function operationProjectId(operation: FileMutationOperation): string {
    return (
        operation.workbenchProjectId ??
        getSessionOwnerProjectId(operation.sessionId) ??
        `session:${operation.sessionId}`
    );
}

async function invalidateDirectory(
    sessionId: string,
    workbenchProjectId: string,
    directory: string,
): Promise<void> {
    await Promise.all(
        getWorkbenchProjectSessionIds(workbenchProjectId, sessionId).map((projectSessionId) =>
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
    const workbenchProjectId = operationProjectId(operation);
    if (operation.kind === 'create') {
        await invalidateDirectory(
            operation.sessionId,
            workbenchProjectId,
            operation.input.directory,
        );
        return;
    }
    await remapOpenEditorsDurably(
        operation.sessionId,
        workbenchProjectId,
        operation.id,
        operation.result.previousPath,
        operation.result.path,
    );
    const directories = [parentDirectoryPath(operation.result.previousPath)];
    if (operation.kind === 'move') directories.push(operation.input.directory);
    await Promise.all(
        [...new Set(directories)].map((directory) =>
            invalidateDirectory(operation.sessionId, workbenchProjectId, directory),
        ),
    );
}

async function invalidateAffectedDirectories(operation: FileMutationOperation): Promise<void> {
    const workbenchProjectId = operationProjectId(operation);
    if (operation.kind === 'create') {
        await invalidateDirectory(
            operation.sessionId,
            workbenchProjectId,
            operation.input.directory,
        );
        return;
    }
    const directories = new Set([parentDirectoryPath(operation.input.path)]);
    if (operation.kind === 'move') directories.add(operation.input.directory);
    if (operation.expectedResult)
        directories.add(parentDirectoryPath(operation.expectedResult.path));
    await Promise.all(
        [...directories].map((directory) =>
            invalidateDirectory(operation.sessionId, workbenchProjectId, directory),
        ),
    );
}

/**
 * Applies each durable result before acknowledging it, making window recovery safely at-least-once.
 */
export function reconcileFileMutation(operation: FileMutationOperation): Promise<void> {
    if (reconciled.has(operation.id)) return Promise.resolve();
    const existing = reconciling.get(operation.id);
    if (existing) return existing;
    const projectId = operationProjectId(operation);
    const store = useFileOperationStore.getState();
    store.begin({
        id: operation.id,
        label: operationLabel(operation),
        projectId,
        affectedPaths: operationAffectedPaths(operation),
        cancelable: true,
    });
    store.update(operation.id, operationLabel(operation));
    if (operation.phase === 'pre_stage' || operation.phase === 'staged') return Promise.resolve();

    const reconciliation = (async (): Promise<void> => {
        try {
            if (operation.phase === 'completed') {
                await applyCompletedOperation(operation);
            } else {
                await invalidateAffectedDirectories(operation);
            }
            await caxri.request('files.operation.acknowledge', { operationId: operation.id });
            useFileOperationStore.getState().finish(operation.id);
            rememberReconciliation(operation.id);
            if (operation.phase === 'completed') pushToast('success', operationSuccess(operation));
            else if (!didConsumeFailureToastSuppression(operation.id))
                pushToast(
                    'error',
                    operation.error?.message ?? 'File operation could not be completed',
                );
        } catch {
            /**
             * Runtime keeps the durable result until every same-Project Session remap and ack succeeds, so a transient
             * persistence failure must retry across Renderer reloads.
             */
            scheduleReconciliationRetry(operation);
        } finally {
            reconciling.delete(operation.id);
        }
    })();
    reconciling.set(operation.id, reconciliation);
    return reconciliation;
}

/**
 * Test-only: exposes the suppression registry's size directly. A black-box assertion through `reconcileFileMutation`
 * cannot observe a leaked entry on its own — that Set's `reconciled` guard (above) makes a second delivery of the
 * _same_ operation id a no-op regardless of suppression state, and a leaked entry for one id has no effect on any other
 * id's registration or consumption. So the only way to see whether a caller's `finally` actually cleared its
 * registration is to read the registry's size before and after.
 */
export function failureToastSuppressionSizeForTests(): number {
    return failureToastSuppressed.size;
}

/**
 * Lets the initiating action join an event-driven reconciliation that won the IPC response race.
 */
export async function didFileMutationReconcile(operationId: string): Promise<boolean> {
    try {
        await reconciling.get(operationId);
    } catch {
        // The pending reconciliation's own retry/backoff handling owns explaining this failure;
        // this caller only needs to know whether the operation ended up reconciled.
    }
    return reconciled.has(operationId);
}

async function loadFileMutations(): Promise<void> {
    const operations = await caxri.request('files.operation.list');
    await Promise.all(operations.map((operation) => reconcileFileMutation(operation)));
}

/**
 * Restores pending/final mutation state after a Renderer reload and after every Runtime restart.
 */
export function useFileMutationReconciliation(isActive: boolean): void {
    useEffect(() => {
        if (!isActive) return;
        const reportRecoveryUnavailable = (): void => {
            pushToast('error', 'File operation recovery is temporarily unavailable');
        };
        // Fire-and-forget: each helper already reports its own failure via the toast above.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void loadFileMutations().catch(reportRecoveryUnavailable);
        return caxri.onEvent((event) => {
            if (event.event === 'files.operationChanged')
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void reconcileFileMutation(event.payload).catch(reportRecoveryUnavailable);
            if (event.event === 'runtime.status' && event.payload.status === 'ready')
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void loadFileMutations().catch(reportRecoveryUnavailable);
        });
    }, [isActive]);
}
