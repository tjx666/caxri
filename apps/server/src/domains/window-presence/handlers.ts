import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import { currentConnectionId } from './request-origin';
import { resolveWindowKey } from './window-key';
import type { WindowPresence } from './window-presence';

interface WindowPresenceHandlerOptions {
    database: Pick<CaxriDatabase, 'windowOpenSessions'>;
    /**
     * Runs when a strip edit moved a window onto a different Session (closing the active entry), so the newly shown
     * Session gets the same Terminal restore a plain `session.select` gives it.
     */
    onSessionActivated: (sessionId: string) => void;
    presence: WindowPresence;
}

/**
 * Per-window presence reports from Desktop Main, and the Open Session strip edits a Renderer makes.
 */
export function createWindowPresenceHandlers(
    options: WindowPresenceHandlerOptions,
): Pick<
    DomainHandlers,
    'window.closePresence' | 'window.openSessions.set' | 'window.reportPresence'
> {
    const { database, onSessionActivated, presence } = options;
    return {
        'window.reportPresence': (report) => {
            presence.report(currentConnectionId(), report);
            return null;
        },
        'window.closePresence': ({ windowKey }) => {
            presence.close(currentConnectionId(), windowKey);
            return null;
        },
        'window.openSessions.set': ({ windowKey, openSessionIds, activeSessionId }) => {
            const key = resolveWindowKey(windowKey);
            const before = database.windowOpenSessions.get(key).activeSessionId;
            const stored = database.windowOpenSessions.set(key, {
                openSessionIds,
                activeSessionId,
            });
            if (stored.activeSessionId !== before) {
                presence.noteViewing(key, stored.activeSessionId);
                if (stored.activeSessionId) onSessionActivated(stored.activeSessionId);
            }
            return stored;
        },
    };
}
