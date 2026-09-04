import type { CSSProperties } from 'react';

/**
 * Mirrors the `h-7` row height in `directory-entries.tsx`. Every sticky offset is derived from it, so the two must
 * change together.
 */
export const FILE_TREE_ROW_HEIGHT = 28;

/**
 * Caps how many ancestors may stack before the pinned header would eat the panel. Ancestors deeper than this share the
 * last slot, leaving the row closest to the viewport visible — the one that actually answers "where am I".
 */
export const MAX_STICKY_ANCESTORS = 5;

const ROW_INDENT = 12;
/**
 * A directory row starts at its disclosure chevron; a file row starts where the chevron would end, so both icon columns
 * line up.
 */
const DIRECTORY_ROW_PADDING = 8;
const LEAF_ROW_PADDING = 23;

export interface FileTreeRowStyleInput {
    depth: number;
    isDirectory: boolean;
    isExpanded: boolean;
}

function stickyAncestorHeight(depth: number): number {
    return Math.min(depth, MAX_STICKY_ANCESTORS) * FILE_TREE_ROW_HEIGHT;
}

/**
 * Positions one file-tree row, including VS Code-style sticky scroll for expanded directories.
 *
 * The tree renders as nested DOM (`<div>{row}{subtree}</div>`), so an expanded directory's element already spans
 * exactly the region where that directory is the ancestor context. `position: sticky` therefore reproduces the sticky
 * ancestor chain with no scroll listener, no overlay, and no ancestor bookkeeping — the browser pins each row while its
 * own subtree is on screen and lets the next sibling push it out. This depends on the tree not being virtualized;
 * introducing virtualization would flatten the DOM and require an explicit overlay instead.
 *
 * Rows carry `scrollMarginTop` so keyboard navigation never scrolls the focused row underneath the pinned ancestors.
 * The explicit `zIndex` is required because every row is `relative`: without it, later siblings would paint over a
 * pinned row. Deeper rows win so an incoming subtree pushes the previous ancestor out cleanly.
 */
export function fileTreeRowStyle({
    depth,
    isDirectory,
    isExpanded,
}: FileTreeRowStyleInput): CSSProperties {
    const paddingLeft =
        (isDirectory ? DIRECTORY_ROW_PADDING : LEAF_ROW_PADDING) + depth * ROW_INDENT;
    const base: CSSProperties = { paddingLeft, scrollMarginTop: stickyAncestorHeight(depth) };
    if (!isDirectory || !isExpanded) return base;
    return {
        ...base,
        position: 'sticky',
        top: Math.min(depth, MAX_STICKY_ANCESTORS - 1) * FILE_TREE_ROW_HEIGHT,
        zIndex: 1 + Math.min(depth, MAX_STICKY_ANCESTORS),
    };
}

/**
 * Indents the inline create/rename editor and the empty/truncated notices to the leaf column of `depth`.
 */
export function fileTreeLeafIndent(depth: number): number {
    return LEAF_ROW_PADDING + depth * ROW_INDENT;
}
