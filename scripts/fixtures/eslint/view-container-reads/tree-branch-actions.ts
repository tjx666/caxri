import { caxri } from './fixture-caxri';

/**
 * Non-compliant fixture: `*-actions.ts` is the Renderer's UI-action layer, not a data layer, so moving a request there
 * does not satisfy the convention. Only `*-client.ts` and `*-commands.ts` name a module that owns server access.
 */
export function collapseTreeBranch(viewId: string, nodeId: string): Promise<unknown> {
    return caxri.request('viewContainers.collapseBranch', { viewId, nodeId });
}
