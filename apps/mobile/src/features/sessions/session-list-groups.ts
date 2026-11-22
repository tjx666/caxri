import type { MobileDashboardResult } from '@caxri/protocol';
import {
    nextRevealedSessionCount,
    SESSION_REVEAL_STEP,
    sessionListWindow,
    WINDOWED_SESSION_LIST_GROUPS,
} from '@caxri/protocol';

import type { SessionListEntry } from './hooks/use-session-polling';
import type { MobileSessionListGroup } from './session-model';

type HeaderEntry = Extract<SessionListEntry, { type: 'header' }>;
type SessionEntry = Extract<SessionListEntry, { type: 'session' }>;

/**
 * What the reader chose for one group: whether it is collapsed to its header, and how far its window was revealed
 * (`undefined` until they ask for more). The revealed count is also how many of the group's rows the phone asks the
 * Server for, so a reveal past the rows it holds loads the next ones.
 */
interface SessionListGroupState {
    isCollapsed?: boolean;
    revealedCount?: number;
}

export type SessionListGroupStates = Partial<Record<MobileSessionListGroup, SessionListGroupState>>;

/**
 * A row the Session list renders: a group header with its Session count, a Session, or the reveal row under a group
 * that has more to show (`Show 10 more`), either rows a windowed group hides or rows the Server has not sent yet.
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
          label: string;
          nextRevealCount: number;
          windowCount: number;
          type: 'reveal';
      };

/**
 * Lays out the (already Project-filtered) entries by the reader's group choices: a collapsed group keeps only its
 * header, and a windowed group shows `sessionListWindow`'s rows. A group gets a reveal row while it hides rows it holds
 * or the Server holds rows the phone has not loaded (`totals`, each group's rows on the Server for the shown filter;
 * `undefined` when the rows are a saved or previous read for another filter, so only the held rows count). The selected
 * Session stays in its window, as on Desktop, so a tablet never shows a selection with no row; pass `undefined` on a
 * phone, which shows no selection.
 */
export function sessionListRows(
    entries: readonly SessionListEntry[],
    states: SessionListGroupStates,
    selectedSessionId: string | undefined,
    totals?: MobileDashboardResult['groupTotals'],
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
        const total = Math.max(totals?.[header.group] ?? 0, sessions.length);
        const unloaded = total - sessions.length;
        rows.push({ ...header, count: total, isCollapsed });
        if (isCollapsed) continue;
        const reveal = (nextRevealCount: number, windowCount: number): void => {
            rows.push({
                id: `reveal:${header.group}`,
                group: header.group,
                label: header.label,
                nextRevealCount,
                windowCount,
                type: 'reveal',
            });
        };
        if (!WINDOWED_SESSION_LIST_GROUPS.has(header.group)) {
            rows.push(...sessions);
            // A reveal already asked for may still be loading; stepping from it asks for the next rows, not the same.
            if (unloaded > 0)
                reveal(
                    Math.min(SESSION_REVEAL_STEP, unloaded),
                    Math.max(sessions.length, state.revealedCount ?? 0),
                );
            continue;
        }
        const window = sessionListWindow(
            sessions.map((entry) => ({ id: entry.session.id, entry })),
            state.revealedCount,
            selectedSessionId,
        );
        rows.push(...window.visibleSessions.map(({ entry }) => entry));
        if (window.hiddenCount + unloaded > 0)
            reveal(
                unloaded > 0
                    ? Math.min(SESSION_REVEAL_STEP, window.hiddenCount + unloaded)
                    : window.nextRevealCount,
                unloaded > 0
                    ? Math.max(window.windowCount, state.revealedCount ?? 0)
                    : window.windowCount,
            );
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

/**
 * Starts every group's window over while keeping what the reader collapsed, for a newly chosen Project filter: rows
 * revealed under one Project say nothing about how far to load another.
 */
export const resetSessionListReveals = (states: SessionListGroupStates): SessionListGroupStates =>
    Object.fromEntries(
        Object.entries(states).map(([group, state]) => [group, { isCollapsed: state.isCollapsed }]),
    );

/**
 * How far a touch on a group heading or reveal row may travel and still count as a tap. The list has no sideways
 * gesture of its own since the Project pager went away, so a sideways swipe across a heading reaches the heading; React
 * Native fires `onPress` for any release inside the heading, which would fold the group under the swipe.
 */
export const SESSION_LIST_TAP_SLOP_DP = 10;

/**
 * Whether a touch that went down at `start` and came up at `end` (page coordinates, dp) is a tap rather than a drag.
 */
export const isSessionListTap = (
    start: { pageX: number; pageY: number },
    end: { pageX: number; pageY: number },
): boolean =>
    Math.hypot(end.pageX - start.pageX, end.pageY - start.pageY) <= SESSION_LIST_TAP_SLOP_DP;
