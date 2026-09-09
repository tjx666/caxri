import type { SessionActivityReason } from '@caxri/protocol';
import { sql } from 'drizzle-orm';

import { sessions } from '../schema';

/**
 * Writes activity and its sidebar promotion atomically. A global lower bound also precedes every row in the owning
 * Project, without moving any other Project's rows. Dragging only writes sidebarOrder and leaves this clock intact.
 */
export function sessionActivityUpdate(reason: SessionActivityReason, now = Date.now()) {
    return {
        lastSessionActivityAt: sql<number>`MAX(${now}, COALESCE((SELECT MAX(${sessions.lastSessionActivityAt}) + 1 FROM ${sessions}), ${now}))`,
        lastSessionActivityReason: reason,
        sidebarOrder: sql<number>`COALESCE((SELECT MIN(${sessions.sidebarOrder}) - 1 FROM ${sessions}), 0)`,
    };
}
