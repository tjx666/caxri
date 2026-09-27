import type { SourceControlTreeNode } from './source-control-tree';
import type { TreeNavigationAction } from './source-control-tree-navigation';

/**
 * Every resource and folder row is `h-7`. The virtualizer lays rows out from this constant, so the two must change
 * together.
 */
export const SOURCE_CONTROL_TREE_ROW_HEIGHT = 28;

/**
 * One visible folder or file row of a group's resource tree, flattened in depth-first order.
 */
export interface SourceControlVisibleRow {
    depth: number;
    /**
     * The persisted disclosure key of a folder row; `undefined` for a file row.
     */
    expansionKey: string | undefined;
    isExpanded: boolean;
    node: SourceControlTreeNode;
    /**
     * Flat index of the enclosing folder row, or `-1` for a row at the group's top level.
     */
    parentIndex: number;
    /**
     * 1-based position among its siblings (`aria-posinset`). A virtualized row cannot rely on the browser counting
     * sibling DOM nodes, because most of its siblings are not mounted.
     */
    positionInSet: number;
    rowId: string;
    /**
     * Number of siblings including this row (`aria-setsize`).
     */
    setSize: number;
}

/**
 * Stable roving-tabindex id of a resource-tree row. Arrow navigation and `data-row-id` selectors in tests read it, so a
 * folder row keeps the provider key (two modes never share a folder's disclosure) and a file row keeps its resource
 * id.
 */
function sourceControlTreeRowId(node: SourceControlTreeNode, providerKey: string): string {
    return node.kind === 'directory'
        ? `directory:${providerKey}:${node.path}`
        : `resource:${node.resource.id}`;
}

/**
 * Flattens a group's resource tree into the rows currently visible, skipping the children of collapsed folders. A
 * folder with no remembered disclosure is expanded, matching VS Code's SCM tree.
 */
export function flattenSourceControlTree(
    nodes: readonly SourceControlTreeNode[],
    providerKey: string,
    expandedDirectories: Readonly<Record<string, boolean | undefined>>,
): SourceControlVisibleRow[] {
    const rows: SourceControlVisibleRow[] = [];
    const visit = (
        siblings: readonly SourceControlTreeNode[],
        depth: number,
        parentIndex: number,
    ): void => {
        for (const [index, node] of siblings.entries()) {
            const expansionKey =
                node.kind === 'directory' ? `${providerKey}:${node.path}` : undefined;
            const isExpanded =
                expansionKey !== undefined && (expandedDirectories[expansionKey] ?? true);
            const rowIndex = rows.length;
            rows.push({
                depth,
                expansionKey,
                isExpanded,
                node,
                parentIndex,
                positionInSet: index + 1,
                rowId: sourceControlTreeRowId(node, providerKey),
                setSize: siblings.length,
            });
            if (isExpanded && node.kind === 'directory') visit(node.children, depth + 1, rowIndex);
        }
    };
    visit(nodes, 0, -1);
    return rows;
}

/**
 * The row a navigation action moves to without leaving this group's resource tree, or `undefined` when the action
 * crosses the tree's edge (or is a disclosure change) and belongs to the surrounding Source Control tree instead.
 *
 * Only the within-tree moves are answered here because only they can target an unmounted row: the rows on either side
 * of the group — the caption above and the next section below — are never virtualized, and the first and last resource
 * rows stay mounted (`sourceControlRenderedIndexes`), so the DOM walk the surrounding tree uses remains correct at the
 * edges.
 */
export function sourceControlTreeNavigationTarget(
    rows: readonly SourceControlVisibleRow[],
    index: number,
    action: TreeNavigationAction,
): number | undefined {
    const row = rows.at(index);
    if (!row) return undefined;
    switch (action) {
        case 'next': {
            return index + 1 < rows.length ? index + 1 : undefined;
        }
        case 'previous': {
            return index > 0 ? index - 1 : undefined;
        }
        case 'parent': {
            return row.parentIndex === -1 ? undefined : row.parentIndex;
        }
        case 'child': {
            const next = rows.at(index + 1);
            return next && next.depth > row.depth ? index + 1 : undefined;
        }
        default: {
            return undefined;
        }
    }
}

/**
 * The row indexes a group's virtualizer mounts: the visible window plus rows that must exist in the DOM regardless of
 * scroll position.
 *
 * - The first and last rows keep the DOM walk across the group's edges exact: arrowing down from the group caption, up
 *   from the section below, or `End` onto the last row always meets the true boundary row, never whichever middle row
 *   happens to be mounted.
 * - The roving Tab stop row stays mounted so scrolling it out of view neither drops keyboard focus to `<body>` nor lets
 *   the tree's DOM reconciliation hand the Tab stop back to the first row.
 *
 * Returned ascending so DOM order keeps matching tree order.
 */
export function sourceControlRenderedIndexes(
    visibleIndexes: readonly number[],
    count: number,
    pinnedIndexes: readonly number[],
): number[] {
    if (count === 0) return [];
    const indexes = new Set(visibleIndexes);
    indexes.add(0);
    indexes.add(count - 1);
    for (const index of pinnedIndexes) if (index >= 0 && index < count) indexes.add(index);
    return [...indexes].toSorted((left, right) => left - right);
}
