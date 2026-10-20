import type { FocusEvent, RefObject } from 'react';
import { useCallback, useMemo, useState } from 'react';

import type { PrimarySidebarSubagentNode, PrimarySidebarTreeRow } from '../primary-sidebar-tree';
import {
    flattenPrimarySidebarRows,
    PINNED_GROUP_ROW_ID,
    rovingPrimarySidebarRowId,
} from '../primary-sidebar-tree';
import type { ProjectSessionWindow } from './use-project-session-windows';
import { useVanishedRowFocus } from './use-vanished-row-focus';

interface PrimarySidebarTreeInput {
    /**
     * True when the Pinned group's window hides at least one Session, which is what puts its reveal row in the order.
     */
    hasHiddenPinnedSessions: boolean;
    isProjectExpanded: (projectId: string) => boolean;
    isPinnedExpanded: boolean;
    /**
     * Pinned Sessions in Pinned order. An empty list means the group renders nothing, heading included.
     */
    pinnedSessionIds: readonly string[];
    /**
     * One windowed Session list per Project, in sidebar order, so the row order can never reach a hidden Session.
     */
    projectWindows: readonly ProjectSessionWindow[];
    selectedProjectId: string | undefined;
    selectedSessionId: string | undefined;
    /**
     * The subagent rows each rendered Session shows, keyed by Session id; empty when the Setting is off.
     */
    subagentNodes: ReadonlyMap<string, PrimarySidebarSubagentNode>;
    /**
     * The `role="tree"` element. Owned by the caller because it is the element the caller renders; the hook only reads
     * it, inside `focusRow`, to find a row by `data-row-id`.
     */
    treeReference: RefObject<HTMLDivElement | null>;
}

export interface PrimarySidebarTreeModel {
    /**
     * Moves DOM focus to a row by id. Used by the paths that have to hand focus over before their own row unmounts.
     */
    focusRow: (rowId: string, options?: FocusOptions) => void;
    handleTreeFocus: (event: FocusEvent<HTMLDivElement>) => void;
    /**
     * Expanded state for any group heading the tree walks, Pinned included: the Project collapse record knows nothing
     * about the Pinned heading's row id.
     */
    isGroupExpanded: (projectId: string) => boolean;
    /**
     * The single row that owns the tree's roving Tab stop.
     */
    rovingRowId: string | undefined;
    rows: PrimarySidebarTreeRow[];
}

/**
 * The PrimarySidebar tree's row order and keyboard focus: which rows exist, which one owns the single roving Tab stop
 * (standard ARIA tree authoring pattern), and how focus moves between them. Extracted from `PrimarySidebar` so that
 * component keeps owning only what it renders.
 */
export function usePrimarySidebarTree({
    hasHiddenPinnedSessions,
    isProjectExpanded,
    isPinnedExpanded,
    pinnedSessionIds,
    projectWindows,
    selectedProjectId,
    selectedSessionId,
    subagentNodes,
    treeReference,
}: PrimarySidebarTreeInput): PrimarySidebarTreeModel {
    /**
     * The last tree row the user actually focused; feeds `rovingPrimarySidebarRowId`'s roving-tabindex resolution.
     */
    const [focusedRowId, setFocusedRowId] = useState<string>();

    /**
     * Flattened row order that Up/Down/Home/End walk; recomputed only when the tree's shape changes.
     */
    const rows = useMemo(
        () =>
            flattenPrimarySidebarRows(
                projectWindows.map((entry) => ({
                    hasHiddenSessions: entry.hiddenCount > 0,
                    id: entry.project.id,
                    sessionIds: entry.visibleSessions.map((session) => session.id),
                })),
                isProjectExpanded,
                {
                    expanded: isPinnedExpanded,
                    hasHiddenSessions: hasHiddenPinnedSessions,
                    sessionIds: pinnedSessionIds,
                },
                subagentNodes,
            ),
        [
            projectWindows,
            isProjectExpanded,
            hasHiddenPinnedSessions,
            isPinnedExpanded,
            pinnedSessionIds,
            subagentNodes,
        ],
    );

    /**
     * Falls back through the selected Session, then the selected Project, then the first row whenever `focusedRowId` is
     * unset or has gone stale (archived Session, collapsed Project).
     */
    const rovingRowId = useMemo(
        () => rovingPrimarySidebarRowId(rows, focusedRowId, selectedSessionId, selectedProjectId),
        [rows, focusedRowId, selectedSessionId, selectedProjectId],
    );

    const focusRow = useCallback(
        (rowId: string, options?: FocusOptions): void => {
            treeReference.current
                ?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(rowId)}"]`)
                ?.focus(options);
        },
        [treeReference],
    );

    const noteFocusedRow = useVanishedRowFocus({ focusRow, rovingRowId, rows });

    const isGroupExpanded = useCallback(
        (projectId: string): boolean =>
            projectId === PINNED_GROUP_ROW_ID ? isPinnedExpanded : isProjectExpanded(projectId),
        [isProjectExpanded, isPinnedExpanded],
    );

    const handleTreeFocus = useCallback(
        (event: FocusEvent<HTMLDivElement>): void => {
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            const rowId = target.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
            if (!rowId) return;
            setFocusedRowId(rowId);
            noteFocusedRow(rowId, target.matches(':focus-visible'));
        },
        [noteFocusedRow],
    );

    return { focusRow, handleTreeFocus, isGroupExpanded, rovingRowId, rows };
}
