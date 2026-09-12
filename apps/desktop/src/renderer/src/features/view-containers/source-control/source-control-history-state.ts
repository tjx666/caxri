import type { SourceControlHistoryPage } from '@caxri/protocol';

type SourceControlHistoryItem = SourceControlHistoryPage['items'][number];

export interface SourceControlHistoryItemsState {
    items: readonly SourceControlHistoryItem[];
    nextOffset: number | undefined;
    selectedId: string | undefined;
}

/**
 * Commits a history page in one shot. Replace must not go through an empty list first: Refresh, path, and revision
 * changes keep the previous page on screen until this replacement arrives.
 */
export function applySourceControlHistoryPage(
    current: SourceControlHistoryItemsState,
    page: Pick<SourceControlHistoryPage, 'items' | 'nextOffset'>,
    shouldReplace: boolean,
): SourceControlHistoryItemsState {
    const items = shouldReplace ? page.items : [...current.items, ...page.items];
    const selectedId =
        current.selectedId !== undefined && items.some((item) => item.id === current.selectedId)
            ? current.selectedId
            : undefined;
    return { items, nextOffset: page.nextOffset, selectedId };
}
