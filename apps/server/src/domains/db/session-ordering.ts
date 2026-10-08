import type { SessionRecord } from '@caxri/protocol';
import {
    CaxriError,
    compareSessionPinnedOrder,
    compareSessionSidebarOrder,
    isPinnedSession,
} from '@caxri/protocol';

import type { CaxriDatabaseConnection } from './database-connection';

/**
 * The list after the drop. Both Session lists reorder the same way: lift the dragged id out, put it back beside the
 * anchor, so the rule lives here once rather than being spelled out per list.
 */
function idsAfterDrop(
    ids: readonly string[],
    sessionId: string,
    anchorSessionId: string,
    placement: 'before' | 'after',
): string[] {
    const next = ids.filter((id) => id !== sessionId);
    next.splice(next.indexOf(anchorSessionId) + (placement === 'after' ? 1 : 0), 0, sessionId);
    return next;
}

/**
 * Reorders a Session inside its own Project group. Resolves the drop against current rows, not a stale client index:
 * activity and dragging are serialized SQLite writes, so the later operation wins without replaying older activity or
 * changing its timestamp.
 */
export function reorderSessionInProject(
    database: CaxriDatabaseConnection,
    sessionId: string,
    anchorSessionId: string,
    placement: 'before' | 'after',
): void {
    const session = database.sessions.get(sessionId);
    const anchor = database.sessions.get(anchorSessionId);
    if (!session || !anchor) throw new CaxriError('NOT_FOUND', 'Session no longer exists');
    if (
        session.projectId !== anchor.projectId ||
        session.archivedAt !== undefined ||
        anchor.archivedAt !== undefined
    )
        throw new CaxriError(
            'VALIDATION',
            'Only active Sessions in the same Project can be reordered',
        );
    if (sessionId === anchorSessionId) return;
    const ids = database.sessions
        .list(session.projectId)
        .filter((row) => row.archivedAt === undefined)
        .toSorted(compareSessionSidebarOrder)
        .map((row) => row.id);
    database.sessions.reorder(idsAfterDrop(ids, sessionId, anchorSessionId, placement));
}

/**
 * Reorders the Pinned group. Unlike `reorderSessionInProject` this deliberately spans Projects: the group's whole point
 * is that it collects Sessions from all of them, but both rows still have to be pinned, so a drag can never pull an
 * ordinary Session into the group's numbering.
 */
export function reorderPinnedSession(
    database: CaxriDatabaseConnection,
    sessionId: string,
    anchorSessionId: string,
    placement: 'before' | 'after',
): void {
    const session = database.sessions.get(sessionId);
    const anchor = database.sessions.get(anchorSessionId);
    if (!session || !anchor) throw new CaxriError('NOT_FOUND', 'Session no longer exists');
    if (!isPinnedSession(session) || !isPinnedSession(anchor))
        throw new CaxriError(
            'VALIDATION',
            'Only pinned Sessions can be reordered in the Pinned group',
        );
    if (sessionId === anchorSessionId) return;
    const ids = database.sessions
        .list()
        .filter((row) => isPinnedSession(row))
        .toSorted(compareSessionPinnedOrder)
        .map((row) => row.id);
    database.sessions.reorderPinned(idsAfterDrop(ids, sessionId, anchorSessionId, placement));
}

/**
 * Pins or unpins one Session. Pinning an archived Session is refused rather than silently unarchiving it: the Pinned
 * group lists active work, and the two states would otherwise contradict each other on screen.
 */
export function setSessionPinned(
    database: CaxriDatabaseConnection,
    sessionId: string,
    shouldPin: boolean,
): SessionRecord {
    const session = database.sessions.get(sessionId);
    if (!session) throw new CaxriError('NOT_FOUND', 'Session no longer exists');
    if (shouldPin && session.archivedAt !== undefined)
        throw new CaxriError('VALIDATION', 'An archived Session cannot be pinned');
    database.sessions.setPinned(sessionId, shouldPin ? Date.now() : null);
    return database.sessions.get(sessionId)!;
}
