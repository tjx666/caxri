import type { VisibleItemRow, VisibleRow } from './extension-tree-rows';

/**
 * Pure arrow-key math for an extension tree view's flattened rows. Kept out of `ExtensionTreeView` so the keyboard
 * contract is covered by fast unit tests instead of an Electron E2E workflow, the same split `primary-sidebar-tree.ts`
 * uses for the PrimarySidebar (see the `unit-testing` skill).
 */

export type ExtensionTreeVerticalKey = 'ArrowDown' | 'ArrowUp' | 'End' | 'Home';

export type ExtensionTreeNavigationKey = ExtensionTreeVerticalKey | 'ArrowLeft' | 'ArrowRight';

/**
 * Whether a row can hold the tree's single roving Tab stop. Only a provider item can: the loading, error, and empty
 * rows are status content the view renders in a branch's place, they own no `TreeItemDto`, and the focus state is keyed
 * by that item. Navigation therefore has to step over them rather than stop on them: a branch that is still fetching
 * must not swallow the Down arrow.
 */
export function isNavigableExtensionTreeRow(row: VisibleRow | undefined): row is VisibleItemRow {
    return row?.kind === 'item';
}

/**
 * First navigable row at or after `start`, walking in `step` direction. Returns `undefined` when the scan runs off
 * either end without finding one, which is what makes an edge press a no-op instead of wrapping.
 */
function findNavigableRowIndex(
    rows: readonly VisibleRow[],
    start: number,
    step: 1 | -1,
): number | undefined {
    for (let index = start; index >= 0 && index < rows.length; index += step)
        if (isNavigableExtensionTreeRow(rows[index])) return index;
    return undefined;
}

/**
 * Resolves Up/Down/Home/End to the row index roving focus should move to, or `undefined` when the key does not move
 * focus (empty tree, or nothing navigable left in that direction). Home and End scan inwards for the same reason Up and
 * Down scan past status rows: a view whose first or last row is a `Loading…` placeholder still has to answer those
 * keys.
 */
export function nextExtensionTreeRowIndex(
    rows: readonly VisibleRow[],
    fromIndex: number,
    key: ExtensionTreeVerticalKey,
): number | undefined {
    if (key === 'Home') return findNavigableRowIndex(rows, 0, 1);
    if (key === 'End') return findNavigableRowIndex(rows, rows.length - 1, -1);
    const step = key === 'ArrowDown' ? 1 : -1;
    return findNavigableRowIndex(rows, fromIndex + step, step);
}

export interface ExtensionTreeHorizontalIntent {
    /**
     * Present when Left/Right should flip the row's own expansion.
     */
    toggle?: true;
    /**
     * Present when Left/Right should move roving focus to another row.
     */
    focusIndex?: number;
    /**
     * Present when Right should move focus from the row into its first inline action (`TreeItem.actions`).
     */
    focusAction?: true;
}

/**
 * Resolves Left/Right per the standard ARIA tree authoring pattern: Right expands a collapsed node and steps into the
 * first child of an expanded one, Left collapses an expanded node and otherwise climbs to the parent. A row that
 * carries inline actions switches Right to the treegrid convention (see `focusAction`).
 *
 * Right on an already expanded node used to do nothing, which is the half of the pattern that leaves a user who opened
 * a branch with the keyboard no way to continue into it with the same key. The step is deliberately refused while the
 * branch's first row is a loading, error, or empty placeholder: there is no child to enter yet, and focus must not land
 * on a row that cannot take it.
 */
export function extensionTreeHorizontalIntent(
    rows: readonly VisibleRow[],
    index: number,
    key: 'ArrowLeft' | 'ArrowRight',
): ExtensionTreeHorizontalIntent {
    const row = rows[index];
    if (!isNavigableExtensionTreeRow(row)) return {};
    const isCollapsible = row.item.collapsibleState !== 'none';
    if (key === 'ArrowLeft') {
        if (isCollapsible && row.isExpanded) return { toggle: true };
        return row.parentIndex === -1 ? {} : { focusIndex: row.parentIndex };
    }
    if (isCollapsible && !row.isExpanded) return { toggle: true };
    // A row with inline actions follows the ARIA treegrid row pattern instead: Right on a leaf or an expanded row moves
    // into the row's first action, the way a treegrid moves to the row's first cell. Down still reaches an expanded
    // row's first child, and rows without actions keep the plain tree behavior below unchanged.
    if (row.item.actions?.length) return { focusAction: true };
    if (!isCollapsible) return {};
    // `flattenVisibleRows` emits a branch's rows directly below it, so the first child is always the next row; the
    // parent test is what keeps an expanded-but-childless node from stepping onto its own next sibling.
    const firstChild = rows[index + 1];
    return isNavigableExtensionTreeRow(firstChild) && firstChild.parentIndex === index
        ? { focusIndex: index + 1 }
        : {};
}
