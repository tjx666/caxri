import type { MethodResult } from '@caxri/protocol';

type TreeChildrenResult = MethodResult<'mobile.tree.children'>;

/**
 * Reads one tree level without ever showing a `reset` snapshot as a branch's children.
 *
 * When the provider refreshed under an expanded branch, the Server answers that branch's read with the current root
 * level and `reset: true`. Rendering those root rows under the branch nests the branch inside itself: a row expanded by
 * default (a running CI check) then re-reads the same cached snapshot forever, which froze and crashed the phone. The
 * snapshot replaces the root level instead, and the branch is read once more against the refreshed tree; a second reset
 * means the branch is gone or still churning, so the read fails and the row offers Retry.
 */
export const readTreeChildren = async ({
    onRootSnapshot,
    parentHandle,
    read,
}: {
    onRootSnapshot: (root: TreeChildrenResult) => void;
    parentHandle?: string;
    read: () => Promise<TreeChildrenResult>;
}): Promise<TreeChildrenResult> => {
    const result = await read();
    if (!result.reset) return result;
    const root = { items: result.items };
    if (parentHandle === undefined) return root;
    onRootSnapshot(root);
    const retry = await read();
    if (!retry.reset) return retry;
    onRootSnapshot({ items: retry.items });
    throw new Error('Tree changed while its branch was loading');
};
