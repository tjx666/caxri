import type { SourceControlHistoryPage } from '@caxri/protocol';

type SourceControlHistoryItem = SourceControlHistoryPage['items'][number];

/**
 * Why a revision-bound action is refused mid-refresh.
 *
 * The panel stays fully interactive while Git re-reads the working tree, so the refusal has to happen at execution time
 * and has to say why: a click that silently does nothing reads as a broken button, and disabling the control instead
 * would take it out of the tree's roving Tab stop several times a minute. Renderer-owned rather than a `presentation`
 * field because every field of `controlledViewPresentationSchema` is required, so adding one would break every provider
 * that already ships a presentation.
 */
export const REFRESHING_ACTION_MESSAGE =
    'Source Control is refreshing. Try that action again in a moment.';

export interface SourceControlHistoryPageIdentity {
    path: string | undefined;
    revision: string | undefined;
}

export interface SourceControlHistoryItemsState {
    committedPath?: string;
    committedRevision?: string;
    items: readonly SourceControlHistoryItem[];
    nextOffset: number | undefined;
    selectedId: string | undefined;
}

/**
 * A kept page is still on screen after snapshot revision or path moves. Its action IDs belong to the committed
 * identity, so clicks and details must wait until the replacement page commits.
 */
export function areSourceControlHistoryActionsCurrent(
    state: Pick<SourceControlHistoryItemsState, 'committedPath' | 'committedRevision'>,
    identity: SourceControlHistoryPageIdentity,
): boolean {
    return (
        identity.revision !== undefined &&
        state.committedRevision === identity.revision &&
        state.committedPath === identity.path
    );
}

/**
 * Commits a history page in one shot. Replace must not go through an empty list first: Refresh, path, and revision
 * changes keep the previous page on screen until this replacement arrives.
 */
export function applySourceControlHistoryPage(
    current: SourceControlHistoryItemsState,
    page: Pick<SourceControlHistoryPage, 'items' | 'nextOffset' | 'revision'> & {
        path?: string;
    },
    shouldReplace: boolean,
): SourceControlHistoryItemsState {
    const items = shouldReplace ? page.items : [...current.items, ...page.items];
    const selectedId =
        current.selectedId !== undefined && items.some((item) => item.id === current.selectedId)
            ? current.selectedId
            : undefined;
    return {
        committedPath: page.path,
        committedRevision: page.revision,
        items,
        nextOffset: page.nextOffset,
        selectedId,
    };
}
