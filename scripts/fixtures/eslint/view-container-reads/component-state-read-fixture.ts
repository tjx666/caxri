import { caxri } from './fixture-caxri';

/**
 * Violation fixture: a read resolved straight into component state, which is what `caxri/server-reads-through-query`
 * exists to catch.
 */
export async function loadTreeChildrenIntoState(
    viewId: string,
    requestId: string,
    setItems: (items: unknown) => void,
): Promise<void> {
    const result = await caxri.request('viewContainers.treeChildren', { viewId, requestId });
    setItems(result);
}

/**
 * Violation fixture: the abortable form of the same mistake. Cancelling on unmount stops the request but does nothing
 * to preserve what already resolved, so `requestWithSignal` has to be matched too.
 */
export async function searchIntoState(
    query: string,
    signal: AbortSignal,
    setResults: (results: unknown) => void,
): Promise<void> {
    const result = await caxri.requestWithSignal('files.search', signal, { query });
    setResults(result);
}
