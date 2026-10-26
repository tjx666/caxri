/**
 * What a tree level renders for its children read. The root level uses full-block status; nested levels use one
 * indented row so the feedback sits under the node that was just expanded.
 */
export type TreeChildrenView =
    'error' | 'nested-empty' | 'nested-loading' | 'root-empty' | 'root-loading' | 'rows';

export const treeChildrenView = ({
    depth,
    isError,
    isPending,
    itemCount,
}: {
    depth: number;
    isError: boolean;
    isPending: boolean;
    itemCount: number;
}): TreeChildrenView => {
    const isRoot = depth === 0;
    if (isPending) return isRoot ? 'root-loading' : 'nested-loading';
    if (isError) return 'error';
    if (itemCount === 0) return isRoot ? 'root-empty' : 'nested-empty';
    return 'rows';
};
