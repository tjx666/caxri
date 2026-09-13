import { caxri } from './fixture-caxri';

/**
 * Compliant fixture: a `*-commands.ts` module is the second half of the convention. A feature's command layer owns the
 * writes and the one-shot reads that no query key describes, so the RPC lives beside the cache layer rather than in the
 * component that triggered it.
 */
export function collapseTreeBranch(viewId: string, nodeId: string): Promise<unknown> {
    return caxri.request('viewContainers.collapseBranch', { viewId, nodeId });
}
