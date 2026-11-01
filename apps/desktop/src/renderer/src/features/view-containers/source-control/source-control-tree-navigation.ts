import type { TreeNavigation } from '../../../lib/tree-navigation';
import { treeNavigationTarget } from '../../../lib/tree-navigation';

/**
 * DOM-order roving-tabindex navigation for Source Control's ARIA `role="tree"` widget, whose rows come from sections
 * that each own their data, so there is no single Renderer-side list of rows to walk. DOM order matches the visual
 * order, so navigation reads `[role="treeitem"]` straight out of the DOM and resolves moves through the shared tree
 * navigation (`lib/tree-navigation.ts`). Movement inside a virtualized group list is resolved against its row model
 * first (`source-control-tree-rows.ts`), because that list mounts only nearby rows.
 */

/**
 * A disabled row cannot take focus, so leaving it in the walk turns an arrow key into a silent dead end: the browser
 * refuses the `focus()` call and the caret stays where it was. Source Control renders disabled rows routinely: a commit
 * whose page no longer matches the current revision, `Load more` while a page is in flight.
 */
export const NAVIGABLE_TREE_ITEM_SELECTOR =
    '[role="treeitem"]:not([disabled]):not([aria-disabled="true"])';

function treeItems(current: HTMLElement): HTMLElement[] {
    const tree = current.closest('[role="tree"]');
    return tree
        ? Array.from(tree.querySelectorAll<HTMLElement>(NAVIGABLE_TREE_ITEM_SELECTOR)).filter(
              (item) => item.closest('[role="tree"]') === tree && !item.closest('[inert]'),
          )
        : [];
}

/**
 * Moves DOM focus to the treeitem `action` resolves to from `current`, reading each row's level from `aria-level`.
 */
export function focusTreeItemTarget(current: HTMLElement, action: TreeNavigation): void {
    const items = treeItems(current);
    const index = items.indexOf(current);
    if (index === -1) return;
    const target = treeNavigationTarget(items, index, action, {
        depthOf: (item) => Number(item.getAttribute('aria-level') ?? '1'),
    });
    if (target !== undefined) items[target].focus();
}

export type TreeNavigationAction = TreeNavigation | 'expand' | 'collapse';

/**
 * Maps tree keys to a focus or disclosure action without depending on one tree's row model.
 */
export function treeNavigationAction(
    key: string,
    isExpandable: boolean,
    isExpanded: boolean,
): TreeNavigationAction | undefined {
    switch (key) {
        case 'ArrowDown':
            return 'next';
        case 'ArrowUp':
            return 'previous';
        case 'Home':
            return 'first';
        case 'End':
            return 'last';
        case 'ArrowRight':
            return isExpandable ? (isExpanded ? 'firstChild' : 'expand') : undefined;
        case 'ArrowLeft':
            return isExpandable && isExpanded ? 'collapse' : 'parent';
        default:
            return undefined;
    }
}
