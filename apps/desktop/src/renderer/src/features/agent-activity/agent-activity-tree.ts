/**
 * Pure row-order and arrow-key math for the Activity view's ARIA tree, kept out of the components so it is covered by
 * fast unit tests rather than an Electron workflow (see the `unit-testing` skill). Mirrors `primary-sidebar-tree.ts` in
 * shape: every group heading is a collapsible focus stop, and a windowed group closes with a `Show N more` row, the
 * same layout the phone's home list draws (`session-list-groups.ts` in `apps/mobile`).
 */

import { sessionListWindow, WINDOWED_SESSION_LIST_GROUPS } from '@caxri/protocol';

import type {
    AgentActivityGroup,
    AgentActivityGroupId,
    AgentActivityRow,
} from './agent-activity-rows';

export type AgentActivityTreeRow =
    | {
          /**
           * A heading's id is its group id. The namespaces cannot collide with a Session row's: a group id is one of a
           * fixed set of words and a row id is an opaque Session id or a `pinned:` one.
           */
          id: AgentActivityGroupId;
          kind: 'group';
          group: AgentActivityGroup;
          expanded: boolean;
      }
    | { id: string; kind: 'session'; row: AgentActivityRow; sessionId: string }
    | {
          /**
           * `reveal:<group>`, a namespace no Session id or group id uses.
           */
          id: string;
          kind: 'reveal';
          groupId: AgentActivityGroupId;
          /**
           * The count the row promises (`Show N more`).
           */
          nextRevealCount: number;
          /**
           * What the next reveal steps from; see `SessionListWindow.windowCount`.
           */
          windowCount: number;
      };

export interface AgentActivityTreeLayout {
    collapsedGroupIds?: ReadonlySet<AgentActivityGroupId>;
    /**
     * How far the user revealed each windowed group, `undefined` until they ask for more.
     */
    revealedCounts?: Partial<Record<AgentActivityGroupId, number>>;
    /**
     * Kept inside its group's window even below it, as the Project tree does, so a selection never has no row.
     */
    selectedSessionId?: string;
}

export function flattenAgentActivityRows(
    groups: readonly AgentActivityGroup[],
    { collapsedGroupIds, revealedCounts, selectedSessionId }: AgentActivityTreeLayout = {},
): AgentActivityTreeRow[] {
    return groups.flatMap((group): AgentActivityTreeRow[] => {
        const isExpanded = !collapsedGroupIds?.has(group.id);
        const heading: AgentActivityTreeRow = {
            expanded: isExpanded,
            group,
            id: group.id,
            kind: 'group',
        };
        if (!isExpanded) return [heading];
        const sessionRow = (row: AgentActivityRow): AgentActivityTreeRow => ({
            id: row.rowId,
            kind: 'session',
            row,
            sessionId: row.session.id,
        });
        if (!WINDOWED_SESSION_LIST_GROUPS.has(group.id))
            return [heading, ...group.rows.map(sessionRow)];
        const window = sessionListWindow(
            group.rows.map((row) => ({ id: row.session.id, row })),
            revealedCounts?.[group.id],
            selectedSessionId,
        );
        return [
            heading,
            ...window.visibleSessions.map(({ row }) => sessionRow(row)),
            ...(window.hiddenCount > 0
                ? [
                      {
                          groupId: group.id,
                          id: `reveal:${group.id}`,
                          kind: 'reveal' as const,
                          nextRevealCount: window.nextRevealCount,
                          windowCount: window.windowCount,
                      },
                  ]
                : []),
        ];
    });
}

export type AgentActivityVerticalKey = 'ArrowDown' | 'ArrowUp' | 'End' | 'Home';

/**
 * Where Up/Down/Home/End should move the roving focus, or `undefined` when the key moves nothing (empty list, or
 * already at the last row in that direction). Every rendered row is a focus stop.
 */
export function nextAgentActivityRowId(
    rows: readonly AgentActivityTreeRow[],
    activeRowId: string | undefined,
    key: AgentActivityVerticalKey,
): string | undefined {
    if (rows.length === 0) return undefined;
    if (key === 'Home') return rows[0]?.id;
    if (key === 'End') return rows.at(-1)?.id;
    const currentIndex = rows.findIndex((row) => row.id === activeRowId);
    if (currentIndex === -1) return rows[0]?.id;
    const nextIndex = currentIndex + (key === 'ArrowDown' ? 1 : -1);
    return nextIndex >= 0 && nextIndex < rows.length ? rows[nextIndex]?.id : undefined;
}

/**
 * Which row owns the tree's single roving Tab stop. Prefers the row the user last focused, but that id goes stale as
 * Sessions change state and move between groups, so it falls back to the selected Session's first row and then to the
 * first row, exactly like a freshly mounted list with no focus history.
 */
export function rovingAgentActivityRowId(
    rows: readonly AgentActivityTreeRow[],
    focusedRowId: string | undefined,
    selectedSessionId: string | undefined,
): string | undefined {
    if (focusedRowId && rows.some((row) => row.id === focusedRowId)) return focusedRowId;
    const selectedRow =
        selectedSessionId === undefined
            ? undefined
            : rows.find((row) => row.kind === 'session' && row.sessionId === selectedSessionId);
    return selectedRow?.id ?? rows[0]?.id;
}
