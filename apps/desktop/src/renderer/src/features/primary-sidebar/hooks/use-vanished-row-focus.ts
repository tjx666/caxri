import { useCallback, useEffect, useRef } from 'react';

import type { PrimarySidebarTreeRow } from '../primary-sidebar-tree';

interface VanishedRowFocusOptions {
    focusRow: (rowId: string) => void;
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
 * @returns The focus handler to notify on every row focus, so the hook knows which row to watch for.
 */
export function useVanishedRowFocus({
    focusRow,
    rovingRowId,
    rows,
}: VanishedRowFocusOptions): (rowId: string) => void {
    const watchedRowId = useRef<string>(undefined);

    useEffect(() => {
        const rowId = watchedRowId.current;
        if (!rowId || rows.some((row) => row.id === rowId)) return;
        watchedRowId.current = undefined;
        if (!rovingRowId || document.activeElement !== document.body) return;
        focusRow(rovingRowId);
    }, [focusRow, rovingRowId, rows]);

    return useCallback((rowId: string) => {
        watchedRowId.current = rowId;
    }, []);
}
