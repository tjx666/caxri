import type { SessionActivityReason } from '@caxri/protocol';
import { sql } from 'drizzle-orm';

import { sessions } from '../schema';

/**
 * A position below every row the table currently holds. A global lower bound also precedes every row in the owning
 * Project, without moving any other Project's rows. It is re-read by each statement that uses it, so consecutive
 * promotions keep stepping further down.
 */
export function sidebarTopOrder() {
    return sql<number>`COALESCE((SELECT MIN(${sessions.sidebarOrder}) - 1 FROM ${sessions}), 0)`;
}

/**
 * The activity reasons that start a turn and so also stamp `turn_started_at`, the clock Running orders by. Raising or
 * ending attention moves only the activity clock.
 */
const TURN_START_REASONS: ReadonlySet<SessionActivityReason> = new Set([
    'agent_started',
    'user_submission',
]);

/**
 * Writes activity and its sidebar promotion atomically. Dragging only writes sidebarOrder and leaves this clock intact.
 */
export function sessionActivityUpdate(reason: SessionActivityReason, now = Date.now()) {
    const sessionActivityAt = sql<number>`MAX(${now}, COALESCE((SELECT MAX(${sessions.sessionActivityAt}) + 1 FROM ${sessions}), ${now}))`;
    return {
        sessionActivityAt,
        sessionActivityReason: reason,
        sidebarOrder: sidebarTopOrder(),
        ...(TURN_START_REASONS.has(reason) && { turnStartedAt: sessionActivityAt }),
    };
}
