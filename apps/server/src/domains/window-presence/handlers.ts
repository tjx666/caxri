import { CaxriError } from '@caxri/protocol';

import type { CaxriDatabase } from '../db';
import type { DomainHandlers } from '../domain-services';
import { currentConnectionId } from './request-origin';
import type { WindowPresence } from './window-presence';

interface WindowPresenceHandlerOptions {
    database: Pick<CaxriDatabase, 'windowOpenSessions'>;
    /**
     * Runs when a strip edit moved a window onto a different Session (closing the active entry), so the newly shown
     * Session gets the same Terminal restore a plain `session.select` gives it.
     */
    onSessionActivated: (sessionId: string) => void;
    /**
     * Pushes the full `state.changed` so every Renderer refetches its own strip after a transfer or release.
     */
    sendFullStateChange: (reason: 'window.openSessions') => void;
    presence: WindowPresence;
}

/**
 * Per-window presence reports from Desktop Main, and the Open Session strip edits a Renderer makes.
 */
export function createWindowPresenceHandlers(
    options: WindowPresenceHandlerOptions,
): Pick<
    DomainHandlers,
    | 'window.closePresence'
    | 'window.openSessions.listTearOffs'
    | 'window.openSessions.moveToWindow'
    | 'window.openSessions.release'
    | 'window.openSessions.set'
    | 'window.reportPresence'
    | 'window.seedPresence'
> {
    const { database, onSessionActivated, presence, sendFullStateChange } = options;
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
            const before = database.windowOpenSessions.get(windowKey).activeSessionId;
            const moved = database.windowOpenSessions.moveToWindow(
                windowKey,
                targetWindowKey,
                sessionId,
            );
            presence.noteViewing(targetWindowKey, sessionId);
            if (moved.source.activeSessionId !== before) {
                presence.noteViewing(windowKey, moved.source.activeSessionId);
                if (moved.source.activeSessionId) onSessionActivated(moved.source.activeSessionId);
            }
            sendFullStateChange('window.openSessions');
            return moved;
        },
        'window.openSessions.release': ({ windowKey }) => {
            database.windowOpenSessions.release(windowKey);
            sendFullStateChange('window.openSessions');
            return null;
        },
        'window.openSessions.listTearOffs': () => database.windowOpenSessions.listTearOffs(),
        'window.openSessions.set': ({ windowKey, openSessionIds }) => {
            if (!windowKey)
                throw new CaxriError('VALIDATION', 'An Open Session edit requires a window');
            const key = windowKey;
            const before = database.windowOpenSessions.get(key).activeSessionId;
            const stored = database.windowOpenSessions.set(key, openSessionIds);
            if (stored.activeSessionId !== before) {
                presence.noteViewing(key, stored.activeSessionId);
                if (stored.activeSessionId) onSessionActivated(stored.activeSessionId);
            }
            return stored;
        },
    };
}
