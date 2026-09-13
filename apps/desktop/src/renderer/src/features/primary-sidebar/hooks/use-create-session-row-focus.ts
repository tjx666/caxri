import { useCallback, useEffect, useRef } from 'react';

import type { PrimarySidebarTreeRow } from '../primary-sidebar-tree';
import { isPrimarySidebarCreateSessionRowId } from '../primary-sidebar-tree';

interface CreateSessionRowFocusOptions {
    focusRow: (rowId: string) => void;
    /**
     * The row that owns the tree's roving Tab stop once the "New Session" row is gone — the Session it just created.
     */
    rovingRowId: string | undefined;
    rows: readonly PrimarySidebarTreeRow[];
}

/**
 * Hands the PrimarySidebar's roving Tab stop over after a "New Session" row creates the Session that replaces it.
 *
 * The reveal and archive paths move focus before their row leaves the DOM, which this row cannot do: the Session
 * arrives asynchronously from the Server, and the row unmounts on the render that receives it. Focus has already fallen
 * to `document.body` by then, which is exactly the state this waits for — a Project collapsing over the row, a Session
 * created with a Terminal that claims focus for its own input, or any other reason the row disappears while the user is
 * elsewhere, all leave focus alone.
 *
 * @returns The focus handler to notify on every row focus, so the hook knows which row to watch for.
 */
export function useCreateSessionRowFocus({
    focusRow,
    rovingRowId,
    rows,
}: CreateSessionRowFocusOptions): (rowId: string) => void {
    const watchedRowId = useRef<string>(undefined);

    useEffect(() => {
        const rowId = watchedRowId.current;
        if (!rowId || rows.some((row) => row.id === rowId)) return;
        watchedRowId.current = undefined;
        if (!rovingRowId || document.activeElement !== document.body) return;
        focusRow(rovingRowId);
    }, [focusRow, rovingRowId, rows]);

    return useCallback((rowId: string) => {
        if (isPrimarySidebarCreateSessionRowId(rowId)) watchedRowId.current = rowId;
    }, []);
}
