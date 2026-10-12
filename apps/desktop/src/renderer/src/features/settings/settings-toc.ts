import type { SettingsListItem } from './settings-search';

/**
 * Anchor id a TOC entry scrolls to: a category id, or `category:subcategory`.
 */
export function settingsAnchorOf(item: SettingsListItem): string | undefined {
    if (item.kind === 'category') return item.category.id;
    if (item.kind === 'subcategory') return `${item.categoryId}:${item.title}`;
    return undefined;
}

/**
 * How far the scroll offset may fall short of an item's start while that item still counts as the top one. Under a
 * fractional window zoom the browser stores `scrollTop` in device pixels, so `scrollToIndex` to a heading at 9240 reads
 * back as 9239.87, and without this slack the previous section's last row (ending at 9240) owned the TOC highlight.
 */
const SCROLL_SPY_TOLERANCE_PX = 1;

/**
 * Scroll-spy: the anchor owning the first item in the viewport drives the TOC highlight. A row inside a subcategory
 * resolves to that subcategory; any other row to its category heading.
 */
export function settingsActiveAnchor(
    list: readonly SettingsListItem[],
    visibleItems: ReadonlyArray<{ index: number; end: number }>,
    scrollOffset: number,
): string | undefined {
    const topItem =
        visibleItems.find((item) => item.end > scrollOffset + SCROLL_SPY_TOLERANCE_PX) ??
        visibleItems.at(0);
    if (topItem === undefined) return;
    for (let index = topItem.index; index >= 0; index -= 1) {
        const item = list[index];
        if (item.kind === 'subcategory' || item.kind === 'category') return settingsAnchorOf(item);
        if (item.row.subcategory) return `${item.row.category}:${item.row.subcategory}`;
    }
    return list[0] ? settingsAnchorOf(list[0]) : undefined;
}
