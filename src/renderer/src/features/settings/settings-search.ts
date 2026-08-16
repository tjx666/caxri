import type { SettingCategoryId } from '@shared/config';

import type { SettingRowDescriptor, SettingsCategory } from './settings-registry';

/**
 * One entry of the flattened Settings list the virtualizer renders: category headings, subcategory headings, and
 * setting rows share a single ordered array.
 */
export type SettingsListItem =
    | { kind: 'category'; id: string; category: SettingsCategory }
    | { kind: 'subcategory'; id: string; categoryId: SettingCategoryId; title: string }
    | { kind: 'row'; id: string; row: SettingRowDescriptor };

/**
 * Whitespace-separated tokens must all appear in a row's haystack (AND semantics), matching how the VS Code settings
 * search narrows as you type. An empty or blank query keeps every row.
 */
export function filterSettingsRows(
    rows: readonly SettingRowDescriptor[],
    query: string,
): SettingRowDescriptor[] {
    const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
    if (tokens.length === 0) return [...rows];
    return rows.filter((row) => tokens.every((token) => row.haystack.includes(token)));
}

/**
 * Flattens visible rows into the virtualized list order, emitting a category heading before its first visible row and a
 * subcategory heading whenever the subcategory changes. Categories with no visible rows disappear entirely.
 */
export function buildSettingsList(
    categories: readonly SettingsCategory[],
    visibleRows: readonly SettingRowDescriptor[],
): SettingsListItem[] {
    const items: SettingsListItem[] = [];
    for (const category of categories) {
        const categoryRows = visibleRows.filter((row) => row.category === category.id);
        if (categoryRows.length === 0) continue;
        items.push({ kind: 'category', id: `category:${category.id}`, category });
        let subcategory: string | undefined;
        for (const row of categoryRows) {
            if (row.subcategory !== subcategory) {
                subcategory = row.subcategory;
                if (subcategory !== undefined)
                    items.push({
                        kind: 'subcategory',
                        id: `subcategory:${category.id}:${subcategory}`,
                        categoryId: category.id,
                        title: subcategory,
                    });
            }
            items.push({ kind: 'row', id: row.id, row });
        }
    }
    return items;
}

/**
 * Visible-row counts per category, driving the match badges in the table of contents.
 */
export function countRowsByCategory(
    visibleRows: readonly SettingRowDescriptor[],
): Partial<Record<SettingCategoryId, number>> {
    const counts: Partial<Record<SettingCategoryId, number>> = {};
    for (const row of visibleRows) counts[row.category] = (counts[row.category] ?? 0) + 1;
    return counts;
}
