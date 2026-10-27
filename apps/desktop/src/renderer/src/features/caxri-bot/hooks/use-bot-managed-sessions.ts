import { useEffect } from 'react';

import { retainBotManagedSessionsFeed } from '../bot-managed-sessions';

/**
 * Keeps the Workbench's view of Caxri Bot ownership current while the caller is mounted: the shared
 * `bot.managedSessions` read behind the Session row marker, and the notice when typing takes a Session back. See
 * `retainBotManagedSessionsFeed`.
 */
export function useBotManagedSessions(): void {
    useEffect(() => retainBotManagedSessionsFeed(), []);
}
