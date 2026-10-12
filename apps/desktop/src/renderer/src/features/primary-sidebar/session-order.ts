import type { SessionRecord } from '@caxri/protocol';

import { translate } from '../../i18n';
import { sessionTitleForDisplay } from '../session/session-title';

export const SESSION_DRAG_TYPE = 'application/x-caxri-session';

export interface SessionDropTarget {
    anchorSessionId: string;
    placement: 'before' | 'after';
}

/**
 * Keeps drop geometry stable while still removing deleted/archived rows and rendering fresh status metadata.
 */
export function frozenSessionOrder(
    sessions: SessionRecord[],
    frozenIds?: readonly string[],
): SessionRecord[] {
    if (!frozenIds) return sessions;
    const byId = new Map(sessions.map((session) => [session.id, session]));
    return frozenIds.flatMap((id) => {
        const session = byId.get(id);
        return session ? [session] : [];
    });
}

export function sessionDropTarget(
    sessions: readonly SessionRecord[],
    draggedId: string | undefined,
    anchorSessionId: string,
    placement: 'before' | 'after',
): SessionDropTarget | undefined {
    const dragged = sessions.find((session) => session.id === draggedId);
    const anchor = sessions.find((session) => session.id === anchorSessionId);
    if (
        !dragged ||
        !anchor ||
        dragged.id === anchor.id ||
        dragged.projectId !== anchor.projectId ||
        dragged.archivedAt !== undefined ||
        anchor.archivedAt !== undefined
    )
        return;
    return { anchorSessionId, placement };
}

/**
 * The rows a list shows, in order, encoded as a memo key. A Session switch replaces records without changing which rows
 * are on screen: the Server stamps the opened Session's `lastOpenedAt`, so the list and that record arrive as new
 * objects while every row keeps its place. Keyed by this string, a memoized id list keeps its identity through that
 * refresh, and a row holding it has no reason to render again. JSON rather than a joined string, so no id can collide
 * with a separator.
 */
export function sessionIdsKey(sessions: ReadonlyArray<Pick<SessionRecord, 'id'>>): string {
    return JSON.stringify(sessions.map((session) => session.id));
}

/**
 * Where `Alt+ArrowUp` / `Alt+ArrowDown` moves a Session: next to its neighbor among the rows its list shows. Hidden
 * rows are not keyboard drop targets (moving into the collapsed tail would unmount the focused row) and a row that has
 * left the list or its group since it rendered (archived, removed, moved to another Project) is skipped, because the
 * ids are resolved against the current records rather than the ones the row last rendered with.
 */
export function keyboardReorderTarget({
    direction,
    groupOf,
    sessionId,
    sessions,
    visibleSessionIds,
}: {
    direction: -1 | 1;
    /**
     * Which list a Session belongs to; only rows in the moved Session's own group are neighbors.
     */
    groupOf: (session: SessionRecord) => string;
    sessionId: string;
    /**
     * The current records, in any order; `visibleSessionIds` owns the order.
     */
    sessions: readonly SessionRecord[];
    visibleSessionIds: readonly string[];
}): SessionDropTarget | undefined {
    const byId = new Map(sessions.map((session) => [session.id, session]));
    const moved = byId.get(sessionId);
    if (!moved) return;
    const group = groupOf(moved);
    const rows = visibleSessionIds.filter((id) => {
        const row = byId.get(id);
        return row !== undefined && groupOf(row) === group;
    });
    const index = rows.indexOf(sessionId);
    const anchorIndex = index + direction;
    if (index === -1 || anchorIndex < 0) return;
    const anchorSessionId = rows.at(anchorIndex);
    if (!anchorSessionId) return;
    return { anchorSessionId, placement: direction === -1 ? 'before' : 'after' };
}

/**
 * The live-region sentence for a finished move. Resolved from the records as they were when the move started: the list
 * keeps refreshing while the Server applies it, and the sentence describes the move the user asked for.
 */
export function sessionMoveAnnouncement(
    sessions: readonly SessionRecord[],
    sessionId: string,
    target: SessionDropTarget,
): string {
    const titleOf = (id: string): string => {
        const title = sessions.find((session) => session.id === id)?.displayTitle;
        return title === undefined
            ? translate('primarySidebar.sessionOrder.fallbackTitle')
            : sessionTitleForDisplay(title, translate);
    };
    return translate(
        target.placement === 'before'
            ? 'primarySidebar.sessionOrder.movedBefore'
            : 'primarySidebar.sessionOrder.movedAfter',
        { anchor: titleOf(target.anchorSessionId), title: titleOf(sessionId) },
    );
}
