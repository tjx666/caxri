/**
 * What a tree level renders for its children read. The root level uses full-block status; nested levels use one
 * indented row so the feedback sits under the node that was just expanded.
 */
export type TreeChildrenView =
    'error' | 'nested-empty' | 'nested-loading' | 'root-empty' | 'root-loading' | 'rows';

/**
 * A level that already loaded keeps its rows when a later re-read fails: every `extensionViews.changed` hint re-reads
 * the whole tree in the background, and while an Agent edits the worktree those reads can lose a race with the next
 * Status refresh. Showing the error there replaced visible Deployments rows with "Couldn't load this view"; the next
 * hint re-reads them anyway. Only a level that never loaded shows the error and Retry.
 */
export const treeChildrenView = ({
    depth,
    hasData,
    isError,
    isPending,
    itemCount,
}: {
    depth: number;
    /**
     * Whether an earlier read of this level succeeded, so its rows are still cached.
     */
    hasData: boolean;
    isError: boolean;
    isPending: boolean;
    itemCount: number;
}): TreeChildrenView => {
    const isRoot = depth === 0;
    if (isPending) return isRoot ? 'root-loading' : 'nested-loading';
    if (isError && !hasData) return 'error';
    if (itemCount === 0) return isRoot ? 'root-empty' : 'nested-empty';
    return 'rows';
};
