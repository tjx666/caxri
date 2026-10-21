import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import { currentConnectionId } from './request-origin';
import type { WindowPresence } from './window-presence';

interface WindowPresenceHandlerOptions {
    database: Pick<CaxriDatabase, 'windowOpenSessions'>;
    /**
     * Pushes the full `state.changed` so every Renderer refetches its own strip after a transfer or release.
     */
    sendFullStateChange: (reason: 'window.openSessions') => void;
    presence: WindowPresence;
}

/**
 * Per-window presence reports from Desktop Main, and the Open Session moves and releases it asks for.
 */
export function createWindowPresenceHandlers(
    options: WindowPresenceHandlerOptions,
): Pick<
    DomainHandlers,
    | 'window.closePresence'
    | 'window.openSessions.listTearOffs'
    | 'window.openSessions.moveToWindow'
    | 'window.openSessions.release'
    | 'window.reportPresence'
    | 'window.seedPresence'
> {
    const { database, presence, sendFullStateChange } = options;
    return {
        'window.reportPresence': (report) => {
            presence.report(currentConnectionId(), report);
            return null;
        },
        'window.seedPresence': ({ windows }) => {
            presence.seed(currentConnectionId(), windows);
            return null;
        },
        'window.closePresence': ({ windowKey }) => {
            presence.close(currentConnectionId(), windowKey);
            return null;
        },
        'window.openSessions.moveToWindow': ({ sessionId, windowKey, targetWindowKey }) => {
            // The source window keeps the Session it shows (the move refuses that one), so only the target's view changes.
            const moved = database.windowOpenSessions.moveToWindow(
                windowKey,
                targetWindowKey,
                sessionId,
            );
            presence.noteViewing(targetWindowKey, sessionId);
            sendFullStateChange('window.openSessions');
            return moved;
        },
        'window.openSessions.release': ({ windowKey }) => {
            database.windowOpenSessions.release(windowKey);
            sendFullStateChange('window.openSessions');
            return null;
        },
        'window.openSessions.listTearOffs': () => database.windowOpenSessions.listTearOffs(),
    };
}
