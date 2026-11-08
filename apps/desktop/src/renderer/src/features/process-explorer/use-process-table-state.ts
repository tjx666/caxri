import { useCallback, useEffect, useState } from 'react';

import { createSharedLocalState } from '../../lib/local-storage';
import type { ProcessColumnKey, ProcessTableState } from './process-columns';
import {
    clampProcessColumnWidth,
    nextProcessSort,
    parseProcessTableState,
    PROCESS_TABLE_STATE_STORAGE_KEY,
} from './process-columns';

/**
 * Shared by every window of the profile (docs/client-local-data.md) but never subscribed: the Process Explorer is one
 * window whose table the user is dragging, so a live update from another instance would fight the drag. The entry only
 * seeds the next window that opens.
 */
const sharedTableState = createSharedLocalState(
    PROCESS_TABLE_STATE_STORAGE_KEY,
    parseProcessTableState,
);

export interface ProcessTableStateController extends ProcessTableState {
    /**
     * Drops the pinned width so the column returns to its definition width, and, for `name`, to auto-fitting the row.
     */
    resetColumnWidth: (key: ProcessColumnKey) => void;
    setColumnWidth: (key: ProcessColumnKey, width: number) => void;
    toggleSort: (column: ProcessColumnKey) => void;
}

/**
 * Owns the Process Explorer table layout: which column sorts the tree and how wide each column is. Both are
 * device-local chrome preferences, so they persist to `localStorage` like the workbench panel sizes rather than to
 * Session state.
 */
export function useProcessTableState(): ProcessTableStateController {
    const [state, setState] = useState<ProcessTableState>(sharedTableState.read);

    useEffect(() => {
        sharedTableState.write(state);
    }, [state]);

    const toggleSort = useCallback((column: ProcessColumnKey): void => {
        setState((current) => ({ ...current, sort: nextProcessSort(current.sort, column) }));
    }, []);

    const setColumnWidth = useCallback((key: ProcessColumnKey, width: number): void => {
        setState((current) => ({
            ...current,
            widths: { ...current.widths, [key]: clampProcessColumnWidth(key, width) },
        }));
    }, []);

    const resetColumnWidth = useCallback((key: ProcessColumnKey): void => {
        setState((current) => {
            const widths = { ...current.widths };
            delete widths[key];
            return { ...current, widths };
        });
    }, []);

    return { ...state, resetColumnWidth, setColumnWidth, toggleSort };
}
