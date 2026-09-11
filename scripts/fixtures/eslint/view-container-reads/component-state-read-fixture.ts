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
