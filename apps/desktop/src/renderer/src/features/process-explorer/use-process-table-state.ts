import { useCallback, useEffect, useState } from 'react';

import type { ProcessColumnKey, ProcessTableState } from './process-columns';
import {
    clampProcessColumnWidth,
    DEFAULT_PROCESS_SORT,
    nextProcessSort,
    parseProcessTableState,
    PROCESS_TABLE_STATE_STORAGE_KEY,
    serializeProcessTableState,
} from './process-columns';

function isBrowser(): boolean {
    // DOM types declare these globals as always present, but this module also loads in Vitest's Node environment.
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- see comment above
    return typeof window !== 'undefined' && globalThis.localStorage !== undefined;
}

function readPersistedState(): ProcessTableState {
    if (!isBrowser()) return { sort: DEFAULT_PROCESS_SORT, widths: {} };
    return parseProcessTableState(localStorage.getItem(PROCESS_TABLE_STATE_STORAGE_KEY));
}

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
    const [state, setState] = useState<ProcessTableState>(readPersistedState);

    useEffect(() => {
        if (!isBrowser()) return;
        try {
            localStorage.setItem(
                PROCESS_TABLE_STATE_STORAGE_KEY,
                serializeProcessTableState(state),
            );
        } catch {
            // Storage-disabled windows keep the layout for this Renderer lifetime only.
        }
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
