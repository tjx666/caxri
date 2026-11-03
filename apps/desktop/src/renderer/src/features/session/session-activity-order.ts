import type { ProjectRecord, SessionRecord } from '@caxri/protocol';

import { sidebarSessionOrder } from '../primary-sidebar/delegated/delegated-order';

interface SidebarSessionOrderOptions {
    /**
     * Drops the `consult` Sessions the Project tree hides under a listed ancestor, for stepping through what the
     * sidebar shows (previous and next Session). The selected Session is never hidden, so pass it too.
     */
    navigableOnly?: boolean;
    selectedSessionId?: string;
}

/**
 * Produces the exact visible Session sequence: Project order remains explicit and stable, while only Sessions inside
 * each Project follow their durable sidebar positions, and a delegated Session follows the host it nests under.
 * Activity promotes one row; dragging does not change recency.
 *
 * Without options this is every Session the sidebar can reach, hidden consults included, for the command palette and
 * the share dialog. The Project tree and previous/next Session read `sidebarSessionOrder` through the options below.
 */
export function activeSessionsInSidebarOrder(
    projects: ReadonlyArray<Pick<ProjectRecord, 'id'>>,
    sessions: readonly SessionRecord[],
    { navigableOnly = false, selectedSessionId }: SidebarSessionOrderOptions = {},
): SessionRecord[] {
    const order = sidebarSessionOrder(projects, sessions, selectedSessionId);
    return navigableOnly ? order.navigable : order.all;
}
