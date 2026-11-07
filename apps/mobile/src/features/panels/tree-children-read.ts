import type { MethodResult } from '@caxri/protocol';

type TreeChildrenResult = MethodResult<'mobile.tree.children'>;

/**
 * How many times a branch read walks its ancestors again after the tree reset under it. While an Agent edits the
 * worktree the Status tree refreshes every two to three seconds, so one walk over the relay often meets the next
 * refresh; a branch that is really gone still fails after this many walks instead of looping.
 */
const MAX_RESET_RECOVERIES = 3;

/**
 * Reads one tree level without ever showing a `reset` snapshot as a branch's children.
 *
 * When the provider refreshed under an expanded branch, the Server answers that branch's read with the current root
 * level and `reset: true`. Rendering those root rows under the branch nests the branch inside itself: a row expanded by
 * default (a running CI check) then re-reads the same cached snapshot forever, which froze and crashed the phone. The
 * snapshot replaces the root level instead, and the branch is read again against the refreshed tree; a reset on every
 * one of {@link MAX_RESET_RECOVERIES} attempts means the branch is gone or still churning, so the read fails.
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
     * Strictly in order: each level registers the handle the next level's read needs. Resolves `false` when a level
     * reset, so the walk starts over from the root.
     */
    const didReloadAncestors = async (handles: readonly string[]): Promise<boolean> => {
        if (handles.length === 0) return true;
        const [ancestorHandle, ...deeper] = handles;
        const level = await read(ancestorHandle);
        if (level.reset) {
            onLevelSnapshot(undefined, { items: level.items });
            return false;
        }
        onLevelSnapshot(ancestorHandle, level);
        return didReloadAncestors(deeper);
    };
    const recover = async (attempt: number): Promise<TreeChildrenResult> => {
        if (attempt > MAX_RESET_RECOVERIES)
            throw new Error('Tree changed while its branch was loading');
        if (!(await didReloadAncestors(ancestorHandles))) return recover(attempt + 1);
        const retry = await read(parentHandle);
        if (!retry.reset) return retry;
        onLevelSnapshot(undefined, { items: retry.items });
        return recover(attempt + 1);
    };
    return recover(1);
};
