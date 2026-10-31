import {
    nextRevealedSessionCount,
    sessionListWindow,
    WINDOWED_SESSION_LIST_GROUPS,
} from '@caxri/protocol';

import type { SessionListEntry } from './hooks/use-session-polling';
import type { MobileSessionListGroup } from './session-model';

type HeaderEntry = Extract<SessionListEntry, { type: 'header' }>;
type SessionEntry = Extract<SessionListEntry, { type: 'session' }>;

/**
 * What the reader chose for one group: whether it is collapsed to its header, and how far its window was revealed
 * (`undefined` until they ask for more).
 */
interface SessionListGroupState {
    isCollapsed?: boolean;
    revealedCount?: number;
}

export type SessionListGroupStates = Partial<Record<MobileSessionListGroup, SessionListGroupState>>;

/**
 * A row the Session list renders: a group header with its Session count, a Session, or the reveal row under a windowed
 * group (`Show 10 more`).
 */
export type SessionListRow =
    | Extract<SessionListEntry, { type: 'session' }>
    | {
          id: string;
          group: MobileSessionListGroup;
          label: string;
          count: number;
          isCollapsed: boolean;
          type: 'header';
      }
    | {
          id: string;
          group: MobileSessionListGroup;
          nextRevealCount: number;
          windowCount: number;
          type: 'reveal';
      };

/**
 * Lays out the (already Project-filtered) entries by the reader's group choices: a collapsed group keeps only its
 * header, and a windowed group shows `sessionListWindow`'s rows and a reveal row while it hides any. The selected
 * Session stays in its window, as on Desktop, so a tablet never shows a selection with no row; pass `undefined` on a
 * phone, which shows no selection.
 */
export function sessionListRows(
    entries: readonly SessionListEntry[],
    states: SessionListGroupStates,
    selectedSessionId: string | undefined,
): SessionListRow[] {
    const rows: SessionListRow[] = [];
    const groups: Array<{ header: HeaderEntry; sessions: SessionEntry[] }> = [];
    for (const entry of entries) {
        if (entry.type === 'header') groups.push({ header: entry, sessions: [] });
        else groups.at(-1)?.sessions.push(entry);
    }
    for (const { header, sessions } of groups) {
        const state = states[header.group] ?? {};
        const isCollapsed = state.isCollapsed === true;
        rows.push({ ...header, count: sessions.length, isCollapsed });
        if (isCollapsed) continue;
        if (!WINDOWED_SESSION_LIST_GROUPS.has(header.group)) {
            rows.push(...sessions);
            continue;
        }
        const window = sessionListWindow(
            sessions.map((entry) => ({ id: entry.session.id, entry })),
            state.revealedCount,
            selectedSessionId,
        );
        rows.push(...window.visibleSessions.map(({ entry }) => entry));
        if (window.hiddenCount > 0)
            rows.push({
                id: `reveal:${header.group}`,
                group: header.group,
                nextRevealCount: window.nextRevealCount,
                windowCount: window.windowCount,
                type: 'reveal',
            });
    }
    return rows;
}

export const toggleSessionListGroup = (
    states: SessionListGroupStates,
    group: MobileSessionListGroup,
): SessionListGroupStates => ({
    ...states,
    [group]: { ...states[group], isCollapsed: states[group]?.isCollapsed !== true },
});

/**
 * Steps a group's window from what it shows (`windowCount`), as Desktop's reveal does.
 */
export const revealSessionListGroup = (
    states: SessionListGroupStates,
    group: MobileSessionListGroup,
    windowCount: number,
): SessionListGroupStates => ({
    ...states,
    [group]: { ...states[group], revealedCount: nextRevealedSessionCount(windowCount) },
});
