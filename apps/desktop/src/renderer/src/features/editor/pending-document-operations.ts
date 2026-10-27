import { isPathAtOrBelow } from '@caxri/protocol';

import { remapPath } from '../../lib/file-path';
import { getBootstrap } from '../../stores/selectors';

export interface PendingDocumentOperation {
    discarded: boolean;
    path: string;
    sessionId: string;
    workbenchRootProjectId?: string;
}

/**
 * Reads and writes can finish after a rename, move, or Trash request. Tracking only active work lets file mutations
 * remap or invalidate it without retaining an unbounded path history.
 */
const pendingDocumentOperations = new Set<PendingDocumentOperation>();

export function trackDocumentOperation(sessionId: string, path: string): PendingDocumentOperation {
    const workbenchRootProjectId = getBootstrap()?.sessions.find(
        (session) => session.id === sessionId,
    )?.workbenchRootProjectId;
    const operation = { discarded: false, path, sessionId, workbenchRootProjectId };
    pendingDocumentOperations.add(operation);
    return operation;
}

export function finishDocumentOperation(operation: PendingDocumentOperation): void {
    pendingDocumentOperations.delete(operation);
}

export function remapPendingDocumentOperations(
    sessionId: string,
    workbenchRootProjectId: string,
    previousPath: string,
    nextPath: string,
): void {
    for (const operation of pendingDocumentOperations) {
        if (
            operation.sessionId === sessionId &&
            operation.workbenchRootProjectId === workbenchRootProjectId &&
            isPathAtOrBelow(operation.path, previousPath)
        )
            operation.path = remapPath(operation.path, previousPath, nextPath);
    }
}

/**
 * Deliberately not narrowed by Workbench Root, unlike {@link remapPendingDocumentOperations} beside it. A rename is
 * root-relative (the same absolute path means a different destination per root) but a Trash is not: the path names one
 * file on disk, and an in-flight read or write of a file that just went to the Trash is stale under every root.
 */
export function discardPendingDocumentOperations(sessionId: string, path: string): void {
    for (const operation of pendingDocumentOperations) {
        if (operation.sessionId === sessionId && isPathAtOrBelow(operation.path, path))
            operation.discarded = true;
    }
}
