import type { SessionRecord } from './domain.js';

/**
 * Canonical newest-first Session Activity order. The ID comparison avoids locale-dependent fallbacks for records whose
 * logical clocks and creation timestamps are equal.
 */
export function compareSessionActivityRecency(
    left: Pick<SessionRecord, 'id' | 'createdAt' | 'lastSessionActivityAt'>,
    right: Pick<SessionRecord, 'id' | 'createdAt' | 'lastSessionActivityAt'>,
): number {
    return (
        right.lastSessionActivityAt - left.lastSessionActivityAt ||
        right.createdAt - left.createdAt ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
}

/**
 * Shared by visible navigation and Server fallback selection so both honor a manual move.
 */
export function compareSessionSidebarOrder(left: SessionRecord, right: SessionRecord): number {
    return left.sidebarOrder - right.sidebarOrder || compareSessionActivityRecency(left, right);
}

export function isPinnedSession(session: Pick<SessionRecord, 'pinnedAt'>): boolean {
    return session.pinnedAt !== undefined;
}

/**
 * Order inside the Pinned group. `pinnedOrder` is only written by a drag, so a Session pinned and never moved falls
 * back to when it was pinned: newest last, which is where the group appended it.
 */
export function compareSessionPinnedOrder(left: SessionRecord, right: SessionRecord): number {
    return (
        (left.pinnedOrder ?? 0) - (right.pinnedOrder ?? 0) ||
        (left.pinnedAt ?? 0) - (right.pinnedAt ?? 0) ||
        (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    );
}
