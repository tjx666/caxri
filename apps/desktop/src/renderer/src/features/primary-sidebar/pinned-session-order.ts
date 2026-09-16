import type { SessionRecord } from '@caxri/protocol';
import { compareSessionPinnedOrder, isPinnedSession } from '@caxri/protocol';

import type { SessionDropTarget } from './session-order';

/**
 * The Pinned group's rows, in the order it renders them. Archived Sessions are filtered out rather than trusted to be
 * unpinned already: archiving clears the pin, but a Session archived by an older build would otherwise surface in a
 * group that promises current work.
 */
export function pinnedSessions(sessions: readonly SessionRecord[]): SessionRecord[] {
    return sessions
        .filter((session) => isPinnedSession(session) && session.archivedAt === undefined)
        .toSorted(compareSessionPinnedOrder);
}

/**
 * Where a drag inside the Pinned group would land, or `undefined` when the drop is a no-op. Unlike the Project groups'
 * `sessionDropTarget` this deliberately allows the two rows to belong to different Projects — collecting Sessions from
 * across Projects is the whole point of the group — but both still have to be pinned, so a drag that started in a
 * Project group cannot renumber the Pinned order.
 */
export function pinnedSessionDropTarget(
    sessions: readonly SessionRecord[],
    draggedId: string | undefined,
    anchorSessionId: string,
    placement: 'before' | 'after',
): SessionDropTarget | undefined {
    const pinned = pinnedSessions(sessions);
    const dragged = pinned.find((session) => session.id === draggedId);
    const anchor = pinned.find((session) => session.id === anchorSessionId);
    if (!dragged || !anchor || dragged.id === anchor.id) return;
    return { anchorSessionId, placement };
}
