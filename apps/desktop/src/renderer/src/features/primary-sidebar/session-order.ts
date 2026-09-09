import type { SessionRecord } from '@caxri/protocol';

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
