import type { Translate } from '../../../i18n';
import type { TreeRowModel, TreeVerticalKey } from '../../../lib/tree-navigation';
import { TREE_VERTICAL_NAVIGATION, treeNavigationTarget } from '../../../lib/tree-navigation';
import type { VisibleItemRow, VisibleRow } from './rows';

/**
 * Pure arrow-key math for an extension tree view's flattened rows. Kept out of `ExtensionTreeView` so the keyboard
 * contract is covered by fast unit tests instead of an Electron E2E workflow, the same split `primary-sidebar-tree.ts`
 * uses for the PrimarySidebar (see the `unit-testing` skill).
 */

export type ExtensionTreeNavigationKey = TreeVerticalKey | 'ArrowLeft' | 'ArrowRight';

/**
 * Whether a row can hold the tree's single roving Tab stop. Only a provider item can: the loading, error, and empty
 * rows are status content the view renders in a branch's place, they own no `TreeItemDto`, and the focus state is keyed
 * by that item. Navigation therefore has to step over them rather than stop on them: a branch that is still fetching
 * must not swallow the Down arrow.
 */
export function isNavigableExtensionTreeRow(row: VisibleRow | undefined): row is VisibleItemRow {
    return row?.kind === 'item';
}

const extensionTreeRowModel: TreeRowModel<VisibleRow> = {
    depthOf: (row) => row.depth,
    isFocusable: isNavigableExtensionTreeRow,
};

/**
 * Resolves Up/Down/Home/End to the row index roving focus should move to, or `undefined` when the key does not move
 * focus (empty tree, or nothing navigable left in that direction). Every key steps over status rows: a view whose first
 * or last row is a `Loading…` placeholder still has to answer Home and End.
 */
export function nextExtensionTreeRowIndex(
    rows: readonly VisibleRow[],
    fromIndex: number,
    key: TreeVerticalKey,
): number | undefined {
    return treeNavigationTarget(
        rows,
        fromIndex,
        TREE_VERTICAL_NAVIGATION[key],
        extensionTreeRowModel,
    );
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
        const parent = treeNavigationTarget(rows, index, 'parent', extensionTreeRowModel);
        return parent === undefined ? {} : { focusIndex: parent };
    }
    if (isCollapsible && !row.isExpanded) return { toggle: true };
    // A row with inline actions follows the ARIA treegrid row pattern instead: Right on a leaf or an expanded row moves
    // into the row's first action, the way a treegrid moves to the row's first cell. Down still reaches an expanded
    // row's first child, and rows without actions keep the plain tree behavior below unchanged.
    if (row.item.actions?.length) return { focusAction: true };
    if (!isCollapsible) return {};
    const firstChild = treeNavigationTarget(rows, index, 'firstChild', extensionTreeRowModel);
    return firstChild === undefined ? {} : { focusIndex: firstChild };
}

/**
 * The visually hidden summary a row with inline actions announces, following {@link extensionTreeHorizontalIntent}: on a
 * collapsed branch Right expands it first, so promising "Right Arrow reaches them" there would send a screen reader
 * user into the children instead. Each action's state explanation (`tooltip`) is spoken beside its name. `Shift+F10`
 * opens the same actions in the row's context menu from either state, so it is named as the shorter way to them.
 */
export function extensionTreeActionsHint(
    actions: ReadonlyArray<{ command: { title: string }; tooltip?: string }>,
    isCollapsedBranch: boolean,
    t: Translate,
): string {
    const names = actions
        .map(({ command, tooltip }) => (tooltip ? `${command.title} (${tooltip})` : command.title))
        .join(', ');
    return t(
        isCollapsedBranch
            ? 'viewContainers.extensionTree.actionsHintCollapsed'
            : 'viewContainers.extensionTree.actionsHint',
        { names },
    );
}
