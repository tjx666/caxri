import type { SettingCategoryId } from '@caxri/protocol';

import type { SettingRowDescriptor, SettingsCategory } from './settings-registry';

/**
 * One entry of the flattened Settings list the virtualizer renders: category headings, subcategory headings, and
 * setting rows share a single ordered array.
 */
export type SettingsListItem =
    | { kind: 'category'; id: string; category: SettingsCategory }
    | { kind: 'subcategory'; id: string; categoryId: SettingCategoryId; title: string }
    | { kind: 'row'; id: string; row: SettingRowDescriptor };

export interface SettingsRowFilterOptions {
    /**
     * Lists advanced rows without a query. Defaults to true.
     */
    showAdvanced?: boolean;
    /**
     * Advanced rows a focus request is scrolling to, listed even while advanced rows are hidden so the request lands.
     */
    revealedRowIds?: ReadonlySet<string>;
}

/**
 * Whitespace-separated tokens must all appear in a row's haystack (AND semantics), matching how the VS Code settings
 * search narrows as you type. A query searches advanced rows too, so hiding them never makes a setting unreachable. An
 * empty or blank query keeps every basic row, and advanced rows only under `showAdvanced` or when revealed.
 */
export function filterSettingsRows(
    rows: readonly SettingRowDescriptor[],
    query: string,
    { showAdvanced = true, revealedRowIds }: SettingsRowFilterOptions = {},
): SettingRowDescriptor[] {
    const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
    if (tokens.length > 0)
        return rows.filter((row) => tokens.every((token) => row.haystack.includes(token)));
    if (showAdvanced) return [...rows];
    return rows.filter((row) => !row.advanced || revealedRowIds?.has(row.id) === true);
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
 * Visible-row counts keyed by category id and by `category:subcategory` anchor, driving the match badges in the table
 * of contents and hiding TOC entries whose section has no visible rows while searching.
 */
export function countRowsByCategory(
    visibleRows: readonly SettingRowDescriptor[],
): Partial<Record<string, number>> {
    const counts: Partial<Record<string, number>> = {};
    for (const row of visibleRows) {
        counts[row.category] = (counts[row.category] ?? 0) + 1;
        if (row.subcategory !== undefined) {
            const anchor = `${row.category}:${row.subcategory}`;
            counts[anchor] = (counts[anchor] ?? 0) + 1;
        }
    }
    return counts;
}
