/**
 * Pure row-order and arrow-key math for the Activity view's ARIA tree, kept out of the components so it is covered by
 * fast unit tests rather than an Electron workflow (see the `unit-testing` skill). Mirrors `primary-sidebar-tree.ts` in
 * shape, but its group headings are not focus targets: the Activity view's groups are derived from Agent state and
 * cannot be collapsed, so there is nothing for focus to do on one.
 */

import type { AgentActivityGroup } from './agent-activity-rows';

export interface AgentActivityTreeRow {
    /**
     * A Session row's id is the Session id; a heading's is its group id. The two namespaces cannot collide because a
     * group id is one of a fixed set of words and a Session id is an opaque identifier.
     */
    id: string;
    kind: 'heading' | 'session';
}

export function flattenAgentActivityRows(
    groups: readonly AgentActivityGroup[],
): AgentActivityTreeRow[] {
    return groups.flatMap((group) => [
        { id: group.id, kind: 'heading' as const },
        ...group.rows.map((row) => ({ id: row.session.id, kind: 'session' as const })),
    ]);
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
    const sessionRows = rows.filter((row) => row.kind === 'session');
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
 * Sessions change state and move between groups, so it falls back to the selected Session's row and then to the first
 * row, exactly like a freshly mounted list with no focus history.
 */
export function rovingAgentActivityRowId(
    rows: readonly AgentActivityTreeRow[],
    focusedRowId: string | undefined,
    selectedSessionId: string | undefined,
): string | undefined {
    const sessionRows = rows.filter((row) => row.kind === 'session');
    if (focusedRowId && sessionRows.some((row) => row.id === focusedRowId)) return focusedRowId;
    if (selectedSessionId && sessionRows.some((row) => row.id === selectedSessionId))
        return selectedSessionId;
    return sessionRows[0]?.id;
}
