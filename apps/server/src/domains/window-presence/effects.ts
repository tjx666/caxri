import type { CaxriDatabase } from '../db';
import { createWindowPresenceHandlers } from './handlers';
import type { WindowPresence } from './window-presence';

interface PresenceEffectsOptions {
    coordinator: { probeSessionPrimaryAgent(sessionId: string): unknown };
    database: Pick<CaxriDatabase, 'windowOpenSessions'>;
    presence: WindowPresence;
    projectStatus: { setPolledSessions(sessionIds: ReadonlySet<string>): void };
    restoreInterruptedTerminalsInBackground: (sessionId: string) => void;
    sendFullStateChange: (reason: 'window.openSessions') => void;
    terminalSuspension: { observeVisibility(): void };
    watchSessionInBackground: (sessionId: string) => void;
}

/**
 * What the Server does when the visible Sessions change. It is the one place that tells background services which
 * Sessions are visible. Project Status polls only those Sessions and the watcher follows the primary one, so every
 * presence change goes through here, or Status goes cold or spends the delivery-CLI budget on an unseen Session. A
 * Session that just became visible also gets its parked or interrupted Terminals back, which covers a restart, a
 * reconnect that reseeds presence, and a window that was hidden long enough for its Agents to be suspended.
 */
export function createPresenceEffects(options: PresenceEffectsOptions): {
    /**
     * The presence reports and Open Session moves Desktop Main and its Renderers send.
     */
    handlers: ReturnType<typeof createWindowPresenceHandlers>;
    /**
     * Records that a window just navigated, so the Session it opened counts as visible before its next full report.
     */
    noteWindowViewing: (windowKey: string, sessionId: string) => void;
    /**
     * Archive, deletion, and hiding move each affected window to a fallback Session without a `session.select`, so
     * every window's active Session is re-announced and its Terminals restored.
     */
    restoreWindowSelections: () => void;
    unsubscribe: () => void;
} {
    const { presence, restoreInterruptedTerminalsInBackground } = options;
    let lastVisibleSessionIds: ReadonlySet<string> = new Set();
    let lastWatchedSessionId: string | undefined;
    /**
     * Points the watcher at the primary visible Session. A focus change skips a Session that is already watched, so
     * flipping between windows on the same Session does not re-run watcher attachment; a visible-set change always
     * re-points it, as before, which also retries a watcher whose setup failed.
     */
    const followPrimaryVisibleSession = (isFocusChange: boolean): void => {
        const watched = presence.primaryVisibleSessionId();
        // Nothing visible keeps the last watcher: tearing it down on every minimize would rescan on every restore.
        if (!watched || (isFocusChange && watched === lastWatchedSessionId)) return;
        lastWatchedSessionId = watched;
        options.watchSessionInBackground(watched);
    };
    const observeVisibleSessions = (): void => {
        const visible = presence.visibleSessionIds();
        options.terminalSuspension.observeVisibility();
        followPrimaryVisibleSession(false);
        options.projectStatus.setPolledSessions(visible);
        for (const sessionId of visible) {
            if (lastVisibleSessionIds.has(sessionId)) continue;
            restoreInterruptedTerminalsInBackground(sessionId);
            options.coordinator.probeSessionPrimaryAgent(sessionId);
        }
        lastVisibleSessionIds = visible;
    };
    const restoreWindowSelections = (): void => {
        const activeSessionIds = new Set<string>();
        for (const [windowKey, window] of Object.entries(
            options.database.windowOpenSessions.all(),
        )) {
            presence.noteViewing(windowKey, window.activeSessionId);
            if (window.activeSessionId) activeSessionIds.add(window.activeSessionId);
        }
        for (const sessionId of activeSessionIds)
            restoreInterruptedTerminalsInBackground(sessionId);
    };
    const unsubscribeVisible = presence.onVisibleChange(observeVisibleSessions);
    // Focus can flip between windows showing different Sessions without changing the visible set, which moves the
    // primary visible Session without firing the visible listener.
    const unsubscribeCurrent = presence.onCurrentChange(() => followPrimaryVisibleSession(true));
    return {
        handlers: createWindowPresenceHandlers({
            database: options.database,
            presence,
            sendFullStateChange: options.sendFullStateChange,
        }),
        noteWindowViewing: (windowKey, sessionId) => presence.noteViewing(windowKey, sessionId),
        restoreWindowSelections,
        unsubscribe: () => {
            unsubscribeVisible();
            unsubscribeCurrent();
        },
    };
}
