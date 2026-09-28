import type { FocusEvent, KeyboardEvent, RefObject } from 'react';
import { useMemo, useState } from 'react';

import type { ProcessRowVerticalKey, ProcessTreeNode, ProcessTreeRow } from './process-tree';
import {
    flattenProcessTree,
    nextProcessRowIndex,
    processRowHorizontalIntent,
    rovingProcessRowId,
    setProcessNodeExpanded,
    setProcessSubtreeExpanded,
} from './process-tree';

const PROCESS_VERTICAL_KEYS: readonly ProcessRowVerticalKey[] = [
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
];

function isProcessVerticalKey(key: string): key is ProcessRowVerticalKey {
    return (PROCESS_VERTICAL_KEYS as readonly string[]).includes(key);
}

/**
 * Expansion, the single roving Tab stop, and keyboard navigation for the process treegrid.
 *
 * The rows are flattened once so the Tab stop and the arrow keys walk exactly what is rendered. A filter opens every
 * row so no match hides inside a folded Terminal.
 */
export function useProcessTreeNavigation({
    isFiltering,
    onStopTerminal,
    roots,
    rowsReference,
}: {
    isFiltering: boolean;
    onStopTerminal: (terminalId: string, name: string) => void;
    roots: readonly ProcessTreeNode[];
    /**
     * The element wrapping the rendered rows, used to move DOM focus between rows.
     */
    rowsReference: RefObject<HTMLDivElement | null>;
}) {
    /**
     * Rows the user flipped away from their default disclosure; see `isProcessNodeExpanded`.
     */
    const [toggled, setToggled] = useState<Set<string>>(() => new Set());
    /**
     * The last row the user focused, which owns the grid's roving Tab stop until that row leaves the sample.
     */
    const [focusedId, setFocusedId] = useState<string>();
    const rows = useMemo(
        () => flattenProcessTree(roots, toggled, isFiltering),
        [isFiltering, roots, toggled],
    );
    const focusRow = (id: string): void =>
        rowsReference.current
            ?.querySelector<HTMLElement>(`[data-process-row-id="${CSS.escape(id)}"]`)
            ?.focus();
    const setRowExpanded = (row: ProcessTreeRow, isExpanded: boolean, isRecursive = false): void =>
        setToggled((current) =>
            isRecursive
                ? setProcessSubtreeExpanded(current, row.node, isExpanded)
                : setProcessNodeExpanded(current, row.node, isExpanded),
        );
    const toggle = (row: ProcessTreeRow, isRecursive: boolean): void =>
        setRowExpanded(row, !row.isExpanded, isRecursive);
    const moveHorizontally = (
        event: KeyboardEvent<HTMLDivElement>,
        row: ProcessTreeRow,
        index: number,
        key: 'ArrowLeft' | 'ArrowRight',
    ): void => {
        const intent = processRowHorizontalIntent(rows, index, key);
        if (intent.expanded !== undefined) {
            event.preventDefault();
            setRowExpanded(row, intent.expanded);
        }
        if (intent.focusIndex !== undefined) {
            event.preventDefault();
            focusRow(rows[intent.focusIndex].node.id);
        }
    };
    /**
     * The process list is a single Tab stop, so these keys are the only way to reach a row that is not the current one:
     * Up/Down/Home/End walk the visible rows, Left/Right collapse, expand, climb to the parent row, or step into the
     * first child, Enter/Space flip the focused row the way clicking it does, and Delete stops a focused Terminal.
     */
    const handleRowKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: ProcessTreeRow): void => {
        if (event.altKey || event.metaKey || event.ctrlKey) return;
        const index = rows.indexOf(row);
        if (index === -1) return;
        const { key } = event;
        if (isProcessVerticalKey(key)) {
            const nextIndex = nextProcessRowIndex(rows, index, key);
            if (nextIndex === undefined) return;
            event.preventDefault();
            focusRow(rows[nextIndex].node.id);
        } else if (key === 'ArrowLeft' || key === 'ArrowRight') {
            moveHorizontally(event, row, index, key);
        } else if ((key === 'Enter' || key === ' ') && row.isExpandable) {
            event.preventDefault();
            toggle(row, false);
        } else if ((key === 'Delete' || key === 'Backspace') && row.node.terminalId) {
            event.preventDefault();
            onStopTerminal(row.node.terminalId, row.node.name);
        }
    };
    const handleRowsFocus = (event: FocusEvent<HTMLDivElement>): void => {
        const id =
            event.target instanceof HTMLElement
                ? event.target.closest<HTMLElement>('[data-process-row-id]')?.dataset.processRowId
                : undefined;
        if (id) setFocusedId(id);
    };
    return {
        handleRowKeyDown,
        handleRowsFocus,
        rovingId: rovingProcessRowId(rows, focusedId),
        rows,
        toggle,
    };
}
