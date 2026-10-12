import type { KeyboardEvent } from 'react';

import { archiveSession } from '../session/session-archive-commands';
import type { PrimarySidebarTreeRow, PrimarySidebarVerticalKey } from './primary-sidebar-tree';
import {
    nextPrimarySidebarRowId,
    primarySidebarArchiveIntent,
    primarySidebarHorizontalIntent,
} from './primary-sidebar-tree';

const PRIMARY_SIDEBAR_VERTICAL_KEYS: readonly PrimarySidebarVerticalKey[] = [
    'ArrowDown',
    'ArrowUp',
    'Home',
    'End',
];

function isPrimarySidebarVerticalKey(key: string): key is PrimarySidebarVerticalKey {
    return (PRIMARY_SIDEBAR_VERTICAL_KEYS as readonly string[]).includes(key);
}

interface PrimarySidebarTreeKeyOptions {
    focusRow: (rowId: string) => void;
    isProjectExpanded: (projectId: string) => boolean;
    rows: readonly PrimarySidebarTreeRow[];
    toggleProject: (projectId: string) => void;
}

/**
 * The PrimarySidebar tree is a single roving Tab stop (standard ARIA tree authoring pattern): only the roving row is a
 * Tab stop, and every inner control (disclosure, "New Session", archived-count, per-row Archive) is `tabIndex={-1}`.
 * This handler supplies the keyboard equivalents that stop being reachable by Tab:
 *
 * - Up/Down/Home/End walk every Project heading and its active Sessions.
 * - Left/Right expand or collapse a Project, step into its first row once it is open, or move a Session row to its owning
 *   Project.
 * - Delete/Backspace on a focused Session row archives it (reversible via the Archived Sessions dialog, so no
 *   confirmation), the keyboard equivalent of the Archive button. Focus moves to the next row (falling back to the
 *   previous row when the archived row was last) before the row leaves the DOM, so the roving Tab stop never falls out
 *   of the tree.
 *
 * Which row each key resolves to is decided by the pure functions in `primary-sidebar-tree.ts`, which are unit tested;
 * what stays here is only the DOM glue those answers drive.
 */
export function handlePrimarySidebarTreeKey(
    event: KeyboardEvent<HTMLDivElement>,
    { focusRow, isProjectExpanded, rows, toggleProject }: PrimarySidebarTreeKeyOptions,
): void {
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest('input, textarea')) return;
    const rowElement = target.closest<HTMLElement>('[data-row-id]');
    const rowId = rowElement?.dataset.rowId;
    if (!rowId) return;
    if (isPrimarySidebarVerticalKey(event.key)) {
        const nextRowId = nextPrimarySidebarRowId(rows, rowId, event.key);
        if (!nextRowId) return;
        event.preventDefault();
        focusRow(nextRowId);
        return;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const row = rows.find((item) => item.id === rowId);
        if (!row) return;
        const intent = primarySidebarHorizontalIntent(
            rows,
            row,
            isProjectExpanded(row.projectId),
            event.key,
        );
        if (intent.expanded !== undefined) {
            event.preventDefault();
            toggleProject(row.projectId);
        }
        if (intent.focusRowId) {
            event.preventDefault();
            focusRow(intent.focusRowId);
        }
        return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
        const row = rows.find((item) => item.id === rowId);
        if (!row) return;
        if (primarySidebarArchiveIntent(row, event.key) !== 'archive' || !row.sessionId) return;
        event.preventDefault();
        // Compute where focus lands before the row leaves the DOM: a group heading is always above a Session row, so
        // the ArrowUp fallback never comes up empty here.
        const focusAfterArchive =
            nextPrimarySidebarRowId(rows, rowId, 'ArrowDown') ??
            nextPrimarySidebarRowId(rows, rowId, 'ArrowUp');
        // `sessionId`, not `row.id`: a row in the Pinned group carries a namespaced row id, and archiving has to reach
        // the Session behind it.
        archiveSession(row.sessionId);
        if (focusAfterArchive) focusRow(focusAfterArchive);
    }
}
