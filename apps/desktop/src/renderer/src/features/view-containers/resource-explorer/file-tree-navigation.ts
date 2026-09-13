/**
 * Roving-tabindex keyboard navigation for the file tree's ARIA `role="tree"` widget. The tree is built from
 * recursively-mounted, independently data-fetched components, so there is no single Renderer-side list of "currently
 * visible rows" to walk. DOM order already matches the intended visual/logical order, though (an expanded directory's
 * children render immediately after its own row), so navigation reads `[role="treeitem"]` straight out of the DOM
 * instead of threading a parallel flattened-tree data structure through every level of props.
 */

export interface TreeItemDescriptor {
    level: number;
}

/**
 * Index of the next/previous treeitem in document order, or `undefined` past either edge.
 */
export function adjacentTreeItemIndex(
    items: readonly TreeItemDescriptor[],
    index: number,
    delta: number,
): number | undefined {
    const next = index + delta;
    return next >= 0 && next < items.length ? next : undefined;
}

/**
 * Index of the nearest earlier treeitem at a shallower `aria-level` than `index` — i.e. this item's tree parent.
 * Depth-first document order guarantees a directory's own row is always the closest preceding row with a smaller
 * level.
 */
export function parentTreeItemIndex(
    items: readonly TreeItemDescriptor[],
    index: number,
): number | undefined {
    // `.at()` (rather than `[index]`) keeps an out-of-range `index`'s `undefined` case in the type, since this project
    // does not enable `noUncheckedIndexedAccess`.
    const level = items.at(index)?.level;
    if (level === undefined) return undefined;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
        if (items[cursor].level < level) return cursor;
    }
    return undefined;
}

function treeItems(current: HTMLElement): HTMLElement[] {
    const tree = current.closest('[role="tree"]');
    return tree
        ? Array.from(tree.querySelectorAll<HTMLElement>('[role="treeitem"]')).filter(
              (item) => item.closest('[role="tree"]') === tree && !item.closest('[inert]'),
          )
        : [];
}

function descriptorsOf(items: readonly HTMLElement[]): TreeItemDescriptor[] {
    return items.map((item) => ({ level: Number(item.getAttribute('aria-level') ?? '1') }));
}

/**
 * Moves DOM focus to the treeitem `delta` positions away from `current` in document order.
 */
export function focusAdjacentTreeItem(current: HTMLElement, delta: number): void {
    const items = treeItems(current);
    const index = items.indexOf(current);
    if (index === -1) return;
    const target = adjacentTreeItemIndex(descriptorsOf(items), index, delta);
    if (target !== undefined) items[target].focus();
}

/**
 * Moves DOM focus to the first or last treeitem in the tree containing `current`.
 */
export function focusTreeItemEdge(current: HTMLElement, edge: 'first' | 'last'): void {
    const items = treeItems(current);
    const target = edge === 'first' ? items[0] : items.at(-1);
    target?.focus();
}

/**
 * Moves DOM focus to `current`'s tree parent (the enclosing directory row), if any.
 */
export function focusParentTreeItem(current: HTMLElement): void {
    const items = treeItems(current);
    const index = items.indexOf(current);
    if (index === -1) return;
    const target = parentTreeItemIndex(descriptorsOf(items), index);
    if (target !== undefined) items[target].focus();
}

/**
 * Focuses the first child only when the next visible row is deeper than the current row.
 */
export function focusFirstChildTreeItem(current: HTMLElement): void {
    const items = treeItems(current);
    const index = items.indexOf(current);
    const next = items.at(index + 1);
    if (index === -1 || !next) return;
    const currentLevel = Number(current.getAttribute('aria-level') ?? '1');
    const nextLevel = Number(next.getAttribute('aria-level') ?? '1');
    if (nextLevel > currentLevel) next.focus();
}

export type TreeNavigationAction =
    'next' | 'previous' | 'first' | 'last' | 'expand' | 'collapse' | 'child' | 'parent';

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
            return isExpandable ? (isExpanded ? 'child' : 'expand') : undefined;
        case 'ArrowLeft':
            return isExpandable && isExpanded ? 'collapse' : 'parent';
        default:
            return undefined;
    }
}
