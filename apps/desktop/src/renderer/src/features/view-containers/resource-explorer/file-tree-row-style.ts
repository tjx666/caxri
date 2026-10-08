import type { CSSProperties } from 'react';

import type { FileTreeRow } from './file-tree-rows';

/**
 * Mirrors the `h-7` row height in `file-tree-item.tsx`. The virtualizer's size estimate and every sticky offset are
 * derived from it, so the two must change together.
 */
export const FILE_TREE_ROW_HEIGHT = 28;

/**
 * Caps how many ancestors may stack before the pinned header would eat the panel.
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
}

/**
 * Indents one file-tree row. Positioning belongs to the virtualizer and the sticky overlay, not the row.
 */
export function fileTreeRowStyle({ depth, isDirectory }: FileTreeRowStyleInput): CSSProperties {
    return {
        paddingLeft: (isDirectory ? DIRECTORY_ROW_PADDING : LEAF_ROW_PADDING) + depth * ROW_INDENT,
    };
}

/**
 * Indents the inline create/rename editor and the empty/truncated notices to the leaf column of `depth`.
 */
export function fileTreeLeafIndent(depth: number): number {
    return LEAF_ROW_PADDING + depth * ROW_INDENT;
}

export interface RowExtent {
    end: number;
    start: number;
}

export interface StickyFileTreeRow {
    index: number;
    /**
     * Offset from the top of the viewport. Below the row's own slot only while its subtree's end is pushing it out.
     */
    top: number;
}

/**
 * Computes the VS Code-style sticky ancestor stack for a virtualized tree.
 *
 * Slot `n` holds the depth-`n` ancestor (or the row itself) of whatever row sits just below the `n` rows already
 * pinned, as long as that directory's own row has scrolled above the slot and its subtree is still on screen. When the
 * subtree's last row rises past the slot's bottom edge, the pinned row is pushed up with it and nothing deeper pins:
 * the same hand-off the next sibling folder performs in VS Code.
 *
 * This replaces per-row `position: sticky`, which relied on every expanded directory's subtree being nested in the DOM
 * and could not survive virtualization.
 */
export function stickyFileTreeRows(
    rows: readonly FileTreeRow[],
    scrollOffset: number,
    extent: (index: number) => RowExtent | undefined,
    rowAt: (offset: number) => number | undefined,
): StickyFileTreeRow[] {
    const pinned: StickyFileTreeRow[] = [];
    for (let slot = 0; slot < MAX_STICKY_ANCESTORS; slot += 1) {
        const slotTop = slot * FILE_TREE_ROW_HEIGHT;
        const line = scrollOffset + slotTop;
        let candidate = rowAt(line);
        while (candidate !== undefined && rows[candidate].depth > slot)
            candidate = rows[candidate].parentRow;
        if (candidate === undefined) break;
        const row = rows[candidate];
        if (row.kind !== 'entry' || row.depth !== slot || !row.isExpanded) break;
        if (row.lastDescendant === candidate) break;
        const own = extent(candidate);
        const subtree = extent(row.lastDescendant);
        if (!own || !subtree || own.start >= line) break;
        const top = Math.min(slotTop, subtree.end - scrollOffset - FILE_TREE_ROW_HEIGHT);
        pinned.push({ index: candidate, top });
        if (top < slotTop) break;
    }
    return pinned;
}

/**
 * How far the ancestors pinned above a row at `depth` reach down the viewport once that row is near the top.
 */
export function stickyCoverage(depth: number): number {
    return Math.min(depth, MAX_STICKY_ANCESTORS) * FILE_TREE_ROW_HEIGHT;
}

/**
 * The scroll offset that brings a row fully into view below its would-be sticky ancestors, or `undefined` when it is
 * already visible. Keyboard movement and Editor reveal go through this instead of `scrollIntoView`, which knows nothing
 * about the overlay and would park the row underneath it.
 */
export function fileTreeRevealOffset({
    depth,
    extent,
    scrollOffset,
    viewportHeight,
}: {
    depth: number;
    extent: RowExtent;
    scrollOffset: number;
    viewportHeight: number;
}): number | undefined {
    const top = extent.start - stickyCoverage(depth);
    if (top < scrollOffset) return Math.max(0, top);
    if (extent.end > scrollOffset + viewportHeight) return Math.max(0, extent.end - viewportHeight);
    return undefined;
}
