import { caxri } from './fixture-caxri';

/**
 * Compliant fixture: a `*-client.ts` module owns the RPC on behalf of the cache layer that calls it, which keeps the
 * request out of components and hooks without pretending the wire call can disappear.
 */
export function requestTreeChildren(viewId: string, requestId: string): Promise<unknown> {
    return caxri.request('viewContainers.treeChildren', { viewId, requestId });
}
