import { useEffect } from 'react';

import type { FileMutationOperation } from '@caxri/protocol';
import { isCaxriError } from '@caxri/protocol';
import { clamp, uniq } from 'es-toolkit';

import { translate } from '../../../i18n';
import { caxri } from '../../../lib/caxri';
import { parentDirectoryPath } from '../../../lib/file-path';
import { queryClient } from '../../../queries/client';
import { getSessionOwnerProjectId, useSelectedSession } from '../../../stores/selectors';
import { pushToast } from '../../../stores/toasts';
import { remapOpenEditorsDurably } from '../../editor/document-commands';
import { availableResourceExplorerClient } from '../resource-explorer-catalog-client';
import { isControlledViewOperationQuery } from '../view-operation-client';
import { useFileOperationStore } from './file-operation-state';
import type { ResourceExplorerClient } from './resource-explorer-client';

const reconciling = new Map<string, Promise<void>>();
const reconciled = new Set<string>();
const retrying = new Map<string, { attempt: number; timer: ReturnType<typeof setTimeout> }>();
const MAXIMUM_REMEMBERED_RECONCILIATIONS = 256;
const RECONCILIATION_RETRY_BASE_MS = 250;
const MAXIMUM_RECONCILIATION_RETRY_MS = 30_000;

/**
 * Coalesces recovery triggers without allowing a second operation-list request to overtake the first one. Server
 * startup, a catalog generation change, and a provider event can all describe the same durable state transition; one
 * queued pass is enough to observe the latest journal and keeps recovery bounded during watcher bursts.
 */
export function createReconciliationQueue(run: () => Promise<void>): {
    request: () => Promise<void>;
    dispose: () => void;
} {
    let isDisposed = false;
    let inFlight: Promise<void> | undefined;
    let isQueued = false;

    const request = (): Promise<void> => {
        if (isDisposed) return Promise.resolve();
        if (inFlight) {
            isQueued = true;
            return inFlight;
        }
        inFlight = (async () => {
            try {
                await run();
            } finally {
                inFlight = undefined;
                // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose may run while run() is awaiting
                if (isQueued && !isDisposed) {
                    isQueued = false;
                    // Fire-and-forget: the queued pass owns its own failure reporting at the caller boundary.
                    // eslint-disable-next-line no-void -- one queued recovery pass follows the completed pass
                    void request();
                } else isQueued = false;
            }
        })();
        return inFlight;
    };

    return {
        request,
        dispose: () => {
            isDisposed = true;
            isQueued = false;
        },
    };
}

/**
 * Operation ids whose failure toast `reconcileFileMutation` must skip entirely, because the caller that started the
 * operation already owns explaining that specific failure itself. The one current user is `file-actions.ts`'s
 * `moveFile`: it registers its first (`reject`-mode) attempt's id before starting, and its own `try`/`catch` decides
 * how to explain any failure: open the interactive Replace/Keep Both/Cancel dialog for `CONFLICT`, or toast once for
 * anything else, so reconciliation must stay silent for that id regardless of the error code, or the caller's message
 * would double up with reconciliation's own. Everything else about reconciliation (acknowledge, store finish, directory
 * invalidation) still runs unconditionally for a suppressed id: only the toast is skipped, and only once per
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

function scheduleReconciliationRetry(
    client: ResourceExplorerClient,
    operation: FileMutationOperation,
): void {
    const previous = retrying.get(operation.id);
    if (previous) clearTimeout(previous.timer);
    else pushToast('info', translate('viewContainers.files.stillSynchronizing'));
    const attempt = (previous?.attempt ?? 0) + 1;
    const delay = clamp(
        RECONCILIATION_RETRY_BASE_MS * 2 ** (attempt - 1),
        MAXIMUM_RECONCILIATION_RETRY_MS,
    );
    const timer = setTimeout(() => {
        // Fire-and-forget: a failed attempt here schedules its own bounded-backoff retry, so
        // there is nothing further to await.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void (async (): Promise<void> => {
            try {
                await reconcileFileMutation(client, operation);
            } catch {
                // The failed attempt schedules its own bounded-backoff retry.
            }
        })();
    }, delay);
    retrying.set(operation.id, { attempt, timer });
}

function operationLabel(operation: FileMutationOperation): string {
    const isStaged = operation.phase === 'staged';
    if (operation.kind === 'create')
        return translate(
            isStaged
                ? 'viewContainers.files.creatingInBackground'
                : 'viewContainers.files.creating',
        );
    if (operation.kind === 'rename')
        return translate(
            isStaged
                ? 'viewContainers.files.renamingInBackground'
                : 'viewContainers.files.renaming',
        );
    return translate(
        isStaged ? 'viewContainers.files.movingInBackground' : 'viewContainers.files.moving',
    );
}

function operationSuccess(operation: FileMutationOperation): string {
    const name = operation.result?.name ?? translate('viewContainers.files.itemFallbackName');
    if (operation.kind === 'create') return translate('viewContainers.files.created', { name });
    if (operation.kind === 'rename') return translate('viewContainers.files.renamed', { name });
    return translate('viewContainers.files.moved', { name });
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

async function applyCompletedOperation(
    client: ResourceExplorerClient,
    operation: FileMutationOperation,
): Promise<void> {
    if (!operation.result) throw new Error('Completed file operation has no result');
    const workbenchProjectId = operationProjectId(operation);
    if (operation.kind === 'create') {
        await invalidateDirectory(client, operation.input.directory);
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
    await Promise.all(uniq(directories).map((directory) => invalidateDirectory(client, directory)));
}

async function invalidateAffectedDirectories(
    client: ResourceExplorerClient,
    operation: FileMutationOperation,
): Promise<void> {
    if (operation.kind === 'create') {
        await invalidateDirectory(client, operation.input.directory);
        return;
    }
    const directories = new Set([parentDirectoryPath(operation.input.path)]);
    if (operation.kind === 'move') directories.add(operation.input.directory);
    if (operation.expectedResult)
        directories.add(parentDirectoryPath(operation.expectedResult.path));
    await Promise.all([...directories].map((directory) => invalidateDirectory(client, directory)));
}

/**
 * Applies each durable result before acknowledging it, making window recovery safely at-least-once.
 */
export function reconcileFileMutation(
    client: ResourceExplorerClient,
    operation: FileMutationOperation,
): Promise<void> {
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
                await applyCompletedOperation(client, operation);
            } else {
                await invalidateAffectedDirectories(client, operation);
            }
            await client.acknowledgeOperation(operation.id);
            useFileOperationStore.getState().finish(operation.id);
            rememberReconciliation(operation.id);
            if (operation.phase === 'completed') pushToast('success', operationSuccess(operation));
            else if (!didConsumeFailureToastSuppression(operation.id))
                pushToast(
                    'error',
                    operation.error?.message ?? translate('viewContainers.files.operationFailed'),
                );
        } catch {
            /**
             * Server keeps the durable result until every same-Project Session remap and ack succeeds, so a transient
             * persistence failure must retry across Renderer reloads.
             */
            scheduleReconciliationRetry(client, operation);
        } finally {
            reconciling.delete(operation.id);
        }
    })();
    reconciling.set(operation.id, reconciliation);
    return reconciliation;
}

/**
 * Test-only: exposes the suppression registry's size directly. A black-box assertion through `reconcileFileMutation`
 * cannot observe a leaked entry on its own: that Set's `reconciled` guard (above) makes a second delivery of the _same_
 * operation id a no-op regardless of suppression state, and a leaked entry for one id has no effect on any other id's
 * registration or consumption. So the only way to see whether a caller's `finally` actually cleared its registration is
 * to read the registry's size before and after.
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
    const client = await availableResourceExplorerClient();
    if (!client) return;
    const operations = await client.listOperations();
    await Promise.all(operations.map((operation) => reconcileFileMutation(client, operation)));
}

/**
 * Restores pending/final mutation state at the application boundary, even when the Files view is not mounted. The The
 * Core client is resolved from the current catalog and selected Session for every pass so restart or scope changes
 * cannot leave recovery holding stale authorization context.
 */
export function useFileMutationReconciliation(isActive: boolean): void {
    const session = useSelectedSession();
    const sessionScope = session ? `${session.id}:${session.workbenchProjectId}` : undefined;
    useEffect(() => {
        if (!isActive || !sessionScope) return;
        const reportRecoveryUnavailable = (): void => {
            pushToast('error', translate('viewContainers.files.recoveryUnavailable'));
        };
        const queue = createReconciliationQueue(async () => {
            try {
                await loadFileMutations();
            } catch (error) {
                if (isCaxriError(error) && error.code === 'CANCELLED') return;
                reportRecoveryUnavailable();
            }
        });
        // Fire-and-forget: the queue coalesces duplicate recovery triggers and reports the list failure above.
        // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
        void queue.request();
        const unsubscribe = caxri.onEvent((event) => {
            const shouldReconcile =
                event.event === 'host.connectionChanged' ||
                (event.event === 'runtime.status' && event.payload.status === 'ready') ||
                event.event === 'files.operationChanged';
            if (shouldReconcile)
                // eslint-disable-next-line no-void -- intentional floating-promise discard, see above
                void queue.request();
        });
        return () => {
            unsubscribe();
            queue.dispose();
        };
    }, [isActive, sessionScope]);
}
