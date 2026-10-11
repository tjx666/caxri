import {
    isConcurrentRead,
    isExtensionViewOperationName,
    isExtensionViewReadOperation,
} from '@caxri/protocol';

const SELF_SERIALIZED_OPERATIONS = new Set([
    'agentChat.saveLongPaste',
    'files.copy',
    'terminal.prepareLongPaste',
]);

/**
 * `viewContainers.viewOperation` is one `control` method that multiplexes Extension view reads and the `source.action`
 * mutation, so the lane decision has to look at the operation. A read operation (`cancellation: 'reject'` in
 * `extensionViewOperationMetadata`) is admitted in order, then settles outside the lane because every layer below
 * already tolerates overlap with later work: Core `ExtensionService.viewOperation` re-asserts the active view context
 * and the provider generation after each await, the Git provider bumps its model revision synchronously and rejects a
 * superseded snapshot or history read after each await, those rejections map to CANCELLED, and the Renderer cancels a
 * replaced snapshot through `viewContainers.cancelRequest` anyway. Production (0.0.95) showed why it matters: a 9.8s
 * `source.snapshot` waiting on a nested Git summary held the Desktop lane and queued `commander.status` and
 * `app.records` for the same 9.8s.
 *
 * `source.action` and `viewContainers.executeCommand` deliberately stay in the lane. They run arbitrary Extension
 * mutations (Git sync, discard, pull request merge) and nothing below the lane serializes them: the Extension Host
 * dispatches requests concurrently and the Git domain has no per-repository mutation queue. Releasing them would let
 * two Desktop clicks overlap on one repository.
 */
function isExtensionViewRead(parameters: unknown): boolean {
    if (typeof parameters !== 'object' || parameters === null) return false;
    const { operation } = parameters as { operation?: unknown };
    return (
        typeof operation === 'string' &&
        isExtensionViewOperationName(operation) &&
        isExtensionViewReadOperation(operation)
    );
}

/**
 * Reads do not carry mutation ordering. Long-running operations may also settle independently only when their domain
 * service serializes its own shared mutations and revalidates authority after every await boundary.
 */
export function shouldSettleOutsideOrderedLane(request: {
    method: string;
    params?: unknown;
}): boolean {
    return (
        isConcurrentRead(request.method) ||
        SELF_SERIALIZED_OPERATIONS.has(request.method) ||
        (request.method === 'viewContainers.viewOperation' && isExtensionViewRead(request.params))
    );
}
