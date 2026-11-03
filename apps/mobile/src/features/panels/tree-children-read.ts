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
 *
 * Re-reading a level retires every handle below it in the Extension Host, so the root snapshot alone only revives the
 * root rows' handles. A deeper branch (the Status panel's Deployments under its repository row) stays unknown until
 * each ancestor level is read again, so the recovery walks `ancestorHandles` top-down before retrying; without that the
 * retry always reset again and the branch showed "Couldn't load this view" after every status refresh.
 */
export const readTreeChildren = async ({
    ancestorHandles = [],
    onLevelSnapshot,
    parentHandle,
    read,
}: {
    /**
     * Handles of the expanded rows between the root level and `parentHandle`, outermost first; empty for a root row's
     * children.
     */
    ancestorHandles?: readonly string[];
    /**
     * Receives every level the recovery re-read, so its cached rows match the handles the Extension Host now knows.
     * `undefined` names the root level.
     */
    onLevelSnapshot: (parentHandle: string | undefined, level: TreeChildrenResult) => void;
    parentHandle?: string;
    read: (parentHandle: string | undefined) => Promise<TreeChildrenResult>;
}): Promise<TreeChildrenResult> => {
    const result = await read(parentHandle);
    if (!result.reset) return result;
    const root = { items: result.items };
    if (parentHandle === undefined) return root;
    onLevelSnapshot(undefined, root);
    /**
     * Strictly in order: each level registers the handle the next level's read needs.
     */
    const reloadAncestors = async (handles: readonly string[]): Promise<void> => {
        if (handles.length === 0) return;
        const [ancestorHandle, ...deeper] = handles;
        const level = await read(ancestorHandle);
        if (level.reset) {
            onLevelSnapshot(undefined, { items: level.items });
            throw new Error('Tree changed while its branch was loading');
        }
        onLevelSnapshot(ancestorHandle, level);
        await reloadAncestors(deeper);
    };
    await reloadAncestors(ancestorHandles);
    const retry = await read(parentHandle);
    if (!retry.reset) return retry;
    onLevelSnapshot(undefined, { items: retry.items });
    throw new Error('Tree changed while its branch was loading');
};
