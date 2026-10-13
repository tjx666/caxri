/**
 * Pure row-order and arrow-key math for the Activity view's ARIA tree, kept out of the components so it is covered by
 * fast unit tests rather than an Electron workflow (see the `unit-testing` skill). Mirrors `primary-sidebar-tree.ts` in
 * shape, but its status group headings are not focus targets: those groups are derived from Agent state and cannot be
 * collapsed, so there is nothing for focus to do on one. The Pinned heading is the exception (`kind: 'group'`): it
 * collapses, so it is a focus stop like the Project tree's Pinned heading.
 */

import type { AgentActivityGroup } from './agent-activity-rows';

export interface AgentActivityTreeRow {
    /**
     * A Session row's id is its `AgentActivityRow.rowId`; a heading's is its group id. The namespaces cannot collide
     * because a group id is one of a fixed set of words and a row id is an opaque Session id or a `pinned:` one.
     */
    id: string;
    /**
     * `heading` is a status group label focus steps over; `group` is the collapsible Pinned heading, which focus lands
     * on.
     */
    kind: 'group' | 'heading' | 'session';
    sessionId?: string;
}

export function flattenAgentActivityRows(
    groups: readonly AgentActivityGroup[],
    { pinnedExpanded = true }: { pinnedExpanded?: boolean } = {},
): AgentActivityTreeRow[] {
    return groups.flatMap((group) => {
        const isCollapsible = group.id === 'pinned';
        const heading = {
            id: group.id,
            kind: isCollapsible ? ('group' as const) : ('heading' as const),
        };
        if (isCollapsible && !pinnedExpanded) return [heading];
        return [
            heading,
            ...group.rows.map((row) => ({
                id: row.rowId,
                kind: 'session' as const,
                sessionId: row.session.id,
            })),
        ];
    });
}

function focusableRows(rows: readonly AgentActivityTreeRow[]): AgentActivityTreeRow[] {
    return rows.filter((row) => row.kind !== 'heading');
}

export type AgentActivityVerticalKey = 'ArrowDown' | 'ArrowUp' | 'End' | 'Home';

/**
 * Where Up/Down/Home/End should move the roving focus, or `undefined` when the key moves nothing (empty list, or
 * already at the last real row in that direction).
 *
 * Headings are stepped over rather than landed on, the same way DESIGN.md has arrow keys step over a branch's
 * `aria-disabled` placeholder: parking focus on text the user cannot act on is worse than a slightly longer jump.
 */
export function nextAgentActivityRowId(
    rows: readonly AgentActivityTreeRow[],
    activeRowId: string | undefined,
    key: AgentActivityVerticalKey,
): string | undefined {
    const sessionRows = focusableRows(rows);
    if (sessionRows.length === 0) return undefined;
    if (key === 'Home') return sessionRows[0]?.id;
    if (key === 'End') return sessionRows.at(-1)?.id;
    const currentIndex = sessionRows.findIndex((row) => row.id === activeRowId);
    if (currentIndex === -1) return sessionRows[0]?.id;
    const nextIndex = currentIndex + (key === 'ArrowDown' ? 1 : -1);
    return nextIndex >= 0 && nextIndex < sessionRows.length
        ? sessionRows[nextIndex]?.id
        : undefined;
}

/**
 * Which row owns the tree's single roving Tab stop. Prefers the row the user last focused, but that id goes stale as
 * Sessions change state and move between groups, so it falls back to the selected Session's first row and then to the
 * first focusable row, exactly like a freshly mounted list with no focus history.
 */
export function rovingAgentActivityRowId(
    rows: readonly AgentActivityTreeRow[],
    focusedRowId: string | undefined,
    selectedSessionId: string | undefined,
): string | undefined {
    const candidates = focusableRows(rows);
    if (focusedRowId && candidates.some((row) => row.id === focusedRowId)) return focusedRowId;
    const selectedRow =
        selectedSessionId === undefined
            ? undefined
            : candidates.find((row) => row.sessionId === selectedSessionId);
    return selectedRow?.id ?? candidates[0]?.id;
}
