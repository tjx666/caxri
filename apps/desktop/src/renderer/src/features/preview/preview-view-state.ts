import type { TableSort } from './csv-row-view';

/**
 * Where a reader left a preview: the scroll offset every view has, plus the PDF view's page and zoom and the table
 * view's sort and filter.
 */
export interface PreviewViewState {
    scrollTop?: number;
    scrollLeft?: number;
    /**
     * PDF only: the 1-based page at the top of the view.
     */
    pageNumber?: number;
    /**
     * PDF only: pdf.js's scale value, either a fit preset (`page-width`, `page-fit`) or a numeric scale as a string, so
     * a fit keeps following the pane after it is restored instead of freezing at the width it had.
     */
    scaleValue?: string;
    /**
     * Table only: the sorted column, or `null` once the reader returned to the file's order.
     */
    tableSort?: TableSort | null;
    /**
     * Table only: the row filter text.
     */
    tableFilter?: string;
}

/**
 * Upper bound on remembered previews. Each entry is a handful of numbers, and a preview that is never reopened would
 * otherwise keep its entry for the window's lifetime; least-recently-used eviction keeps the ones a reader moves
 * between, which is the case this cache exists for.
 */
const VIEW_STATE_LIMIT = 100;

/**
 * Preview positions by Session, pane, and source path. Switching tabs unmounts a preview and a Session switch remounts
 * the whole pane tree, so nothing inside the view survives to restore from; the position has to be held outside the
 * component that dies, the same way `editor-view-state.ts` holds Monaco's. Keying on the pane keeps two split panes
 * showing one file independent.
 */
const viewStates = new Map<string, PreviewViewState>();

export function previewViewStateKey(sessionId: string, paneId: string, path: string): string {
    return `${sessionId}\0${paneId}\0${path}`;
}

/**
 * Merges `state` into the remembered position. Called on every scroll, so it does only Map work.
 */
export function rememberPreviewViewState(key: string, state: PreviewViewState): void {
    const merged = { ...viewStates.get(key), ...state };
    // Re-inserting moves the entry to the end, so eviction below drops the least recently used preview.
    viewStates.delete(key);
    viewStates.set(key, merged);
    while (viewStates.size > VIEW_STATE_LIMIT) {
        const oldest = viewStates.keys().next();
        if (oldest.done) break;
        viewStates.delete(oldest.value);
    }
}

export function readPreviewViewState(key: string): PreviewViewState | undefined {
    return viewStates.get(key);
}

/**
 * Test seam: the cache is module state shared by every preview in the window.
 */
export function clearPreviewViewStates(): void {
    viewStates.clear();
}
