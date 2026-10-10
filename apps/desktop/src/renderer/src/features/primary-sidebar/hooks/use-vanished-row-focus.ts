import { useCallback, useEffect, useRef } from 'react';

import type { PrimarySidebarTreeRow } from '../primary-sidebar-tree';

interface VanishedRowFocusOptions {
    focusRow: (rowId: string, options?: FocusOptions) => void;
    /**
     * The row that owns the tree's roving Tab stop once the vanished row is gone.
     */
    rovingRowId: string | undefined;
    rows: readonly PrimarySidebarTreeRow[];
}

/**
 * Recovers the PrimarySidebar's roving Tab stop after the focused row unmounts without handing focus over first.
 *
 * Most paths that remove a row move focus before the row leaves the DOM: the reveal row and the Delete/Backspace
 * archive both do. Two cannot: the "New Session" row is replaced by a Session that arrives asynchronously from the
 * Server, and unpinning removes the Pinned copy of a row on the refresh that follows the command. Focus has already
 * fallen to `document.body` by then, which is exactly the state this waits for: a row that vanished while the user was
 * somewhere else leaves focus alone, because `document.activeElement` is not the body.
 *
 * The replacement row inherits whether the vanished row showed `:focus-visible`. A bare `focus()` lets Chromium decide
 * from the last input modality instead, so a row the user had only clicked, then pinned from its context menu after any
 * keypress (even the Cmd of a Cmd+Tab), came back wearing the keyboard focus ring.
 *
 * @returns The focus handler to notify on every row focus, so the hook knows which row to watch for and how it was
 *   focused.
 */
export function useVanishedRowFocus({
    focusRow,
    rovingRowId,
    rows,
}: VanishedRowFocusOptions): (rowId: string, wasFocusVisible: boolean) => void {
    const watchedRow = useRef<{ rowId: string; wasFocusVisible: boolean }>(undefined);

    useEffect(() => {
        const watched = watchedRow.current;
        if (!watched || rows.some((row) => row.id === watched.rowId)) return;
        watchedRow.current = undefined;
        if (!rovingRowId || document.activeElement !== document.body) return;
        focusRow(rovingRowId, { focusVisible: watched.wasFocusVisible });
    }, [focusRow, rovingRowId, rows]);

    return useCallback((rowId: string, wasFocusVisible: boolean) => {
        watchedRow.current = { rowId, wasFocusVisible };
    }, []);
}
