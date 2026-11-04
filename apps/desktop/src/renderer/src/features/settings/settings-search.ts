import type { SettingCategoryId } from '@caxri/protocol';

import { hasOwnSurface } from './setting-row-layout';
import type {
    SettingRowDescriptor,
    SettingsCategory,
    SettingSubcategory,
} from './settings-registry';

/**
 * Where a row sits in the card it shares with its neighbours. The virtualizer positions every row on its own, so the
 * card is drawn piecewise: the first row rounds the top corners, every later row draws the divider above itself, and
 * the last row rounds the bottom corners and leaves the gap before whatever follows.
 */
export interface SettingsCardPosition {
    first: boolean;
    last: boolean;
}

/**
 * One entry of the flattened Settings list the virtualizer renders: category headings, subcategory headings, and
 * setting rows share a single ordered array.
 */
export type SettingsListItem =
    | { kind: 'category'; id: string; category: SettingsCategory }
    | {
          kind: 'subcategory';
          id: string;
          categoryId: SettingCategoryId;
          subcategory: SettingSubcategory;
      }
    | { kind: 'row'; id: string; row: SettingRowDescriptor; card: SettingsCardPosition };

export interface SettingsRowFilterOptions {
    /**
     * Lists advanced rows without a query. Defaults to true.
     */
    showAdvanced?: boolean;
    /**
     * Advanced rows a focus request is scrolling to, listed even while advanced rows are hidden so the request lands.
     */
    revealedRowIds?: ReadonlySet<string>;
    /**
     * Advanced rows whose value differs from the default. They stay listed while advanced rows are hidden, so a changed
     * value never disappears from the list that edits it.
     */
    modifiedRowIds?: ReadonlySet<string>;
}

function isRowListedWithoutAdvanced(
    row: SettingRowDescriptor,
    { revealedRowIds, modifiedRowIds }: SettingsRowFilterOptions,
): boolean {
    return (
        !row.advanced ||
        revealedRowIds?.has(row.id) === true ||
        modifiedRowIds?.has(row.id) === true
    );
}

/**
 * How many advanced rows the list leaves out while Show advanced settings is off and no query is typed, for the muted
 * "N advanced settings hidden" line by the switch.
 */
export function countHiddenAdvancedRows(
    rows: readonly SettingRowDescriptor[],
    options: SettingsRowFilterOptions,
): number {
    return rows.filter((row) => !isRowListedWithoutAdvanced(row, options)).length;
}

/**
 * Whitespace-separated tokens must all appear in a row's haystack (AND semantics), matching how the VS Code settings
 * search narrows as you type. A query searches advanced rows too, so hiding them never makes a setting unreachable. An
 * empty or blank query keeps every basic row, and advanced rows only under `showAdvanced` or when revealed.
 */
export function filterSettingsRows(
    rows: readonly SettingRowDescriptor[],
    query: string,
    options: SettingsRowFilterOptions = {},
): SettingRowDescriptor[] {
    const { showAdvanced = true } = options;
    const tokens = query.toLowerCase().split(/\s+/u).filter(Boolean);
    if (tokens.length > 0)
        return rows.filter((row) => tokens.every((token) => row.haystack.includes(token)));
    if (showAdvanced) return [...rows];
    return rows.filter((row) => isRowListedWithoutAdvanced(row, options));
}

/**
 * Flattens visible rows into the virtualized list order, emitting a category heading before its first visible row and a
 * subcategory heading whenever the subcategory changes. Categories with no visible rows disappear entirely.
 *
 * Consecutive rows under one heading share a card. A row that draws its own surface (the Hosts list) stands alone, so
 * the rows before and after it close and open cards of their own.
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
        let subcategory: SettingSubcategory | undefined;
        let previous: Extract<SettingsListItem, { kind: 'row' }> | undefined;
        for (const row of categoryRows) {
            let startsCard =
                previous === undefined || hasOwnSurface(row) || hasOwnSurface(previous.row);
            if (row.subcategory !== subcategory) {
                subcategory = row.subcategory;
                startsCard = true;
                if (subcategory !== undefined)
                    items.push({
                        kind: 'subcategory',
                        id: `subcategory:${category.id}:${subcategory.id}`,
                        categoryId: category.id,
                        subcategory,
                    });
            }
            if (startsCard && previous) previous.card.last = true;
            previous = { kind: 'row', id: row.id, row, card: { first: startsCard, last: false } };
            items.push(previous);
        }
        if (previous) previous.card.last = true;
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
            const anchor = `${row.category}:${row.subcategory.id}`;
            counts[anchor] = (counts[anchor] ?? 0) + 1;
        }
    }
    return counts;
}
