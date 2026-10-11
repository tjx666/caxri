import { isNonExpiringViewOperation } from '@caxri/protocol';

import type { ExtensionHostRequest } from '../../extension-host/protocol';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Supervisor timeout for an Extension Host request. A view operation whose protocol metadata marks it non-expiring gets
 * no timeout; every other request expires after the shared budget.
 */
export function requestTimeout(
    method: ExtensionHostRequest['method'],
    parameters: ExtensionHostRequest['params'],
): number | undefined {
    if (method !== 'viewOperation') return REQUEST_TIMEOUT_MS;
    const operation = (
        parameters as Extract<ExtensionHostRequest, { method: 'viewOperation' }>['params']
    ).operation;
    return isNonExpiringViewOperation(operation) ? undefined : REQUEST_TIMEOUT_MS;
}

/**
 * Request identifier the supervisor sends in a `cancel` message when a tree or view request times out, so the Extension
 * Host can abort the provider work instead of the supervisor killing the child.
 */
export function cancellableRequestId(
    method: ExtensionHostRequest['method'],
    parameters: ExtensionHostRequest['params'],
): string | undefined {
    if (method === 'treeChildren')
        return (parameters as Extract<ExtensionHostRequest, { method: 'treeChildren' }>['params'])
            .requestId;
    if (method === 'viewOperation')
        return (parameters as Extract<ExtensionHostRequest, { method: 'viewOperation' }>['params'])
            .requestId;
    return undefined;
}
