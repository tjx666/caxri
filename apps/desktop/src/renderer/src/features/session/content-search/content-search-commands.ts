import { setArchivedSessionsOpen, setSessionContentSearchOpen } from '../../../stores/dialogs';
import { getBootstrap } from '../../../stores/selectors';
import { openSession } from '../session-commands';

/**
 * Recheck current archive state; selecting a result never implicitly restores a Session.
 */
export function openContentSearchResult(sessionId: string): void {
    const session = getBootstrap()?.sessions.find((entry) => entry.id === sessionId);
    if (!session) return;
    setSessionContentSearchOpen(false);
    if (session.archivedAt !== undefined) setArchivedSessionsOpen(true);
    else openSession(sessionId);
}
