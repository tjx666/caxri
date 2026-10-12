import { useEffect } from 'react';

import { retainCommanderManagedSessionsFeed } from '../commander-managed-sessions';

/**
 * Keeps the Workbench's view of Commander ownership current while the caller is mounted: the shared
 * `commander.managedSessions` read behind the Session row marker, and the notice when typing takes a Session back. See
 * `retainCommanderManagedSessionsFeed`.
 */
export function useCommanderManagedSessions(): void {
    useEffect(() => retainCommanderManagedSessionsFeed(), []);
}
