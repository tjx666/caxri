import type { WindowPresenceReport, WindowPresenceSeed } from '@caxri/protocol';
import { notifyListeners } from '@caxri/utils';

interface PresenceRow {
    focused: boolean;
    /**
     * When the window last gained focus, so "the most recently focused window" survives every window losing focus. Zero
     * for a window that never had it.
     */
    focusedAt: number;
    viewingSessionId: string | null;
    visible: boolean;
}

type Listener = () => void;

const EMPTY: ReadonlySet<string> = new Set();

/**
 * How long a Server with no reported window waits for Desktop Main to seed one before it accepts "no window is visible"
 * as the truth. A restarted Server and a Desktop that just lost its connection both start with no rows; Main reseeds
 * within the reconnect handshake, so this only bounds the case where it never does (Desktop quit, or a headless
 * Server), after which background Terminals may suspend again.
 */
export const PRESENCE_SEED_GRACE_MS = 30_000;

/**
 * Derives the visible set and the current Session from every reported window row.
 */
function deriveViews(rows: ReadonlyMap<string, ReadonlyMap<string, PresenceRow>>): {
    current: string | undefined;
    visible: Set<string>;
} {
    const visible = new Set<string>();
    let focusedBest: { at: number; sessionId: string } | undefined;
    let recentBest: { at: number; sessionId: string } | undefined;
    const viewing = rows
        .values()
        .flatMap((windows) => windows.values())
        .filter(
            (row): row is PresenceRow & { viewingSessionId: string } =>
                row.viewingSessionId !== null,
        )
        .toArray();
    for (const row of viewing) {
        const sessionId = row.viewingSessionId;
        if (row.visible) visible.add(sessionId);
        if (row.focused && (!focusedBest || row.focusedAt >= focusedBest.at))
            focusedBest = { at: row.focusedAt, sessionId };
        if (!recentBest || row.focusedAt >= recentBest.at)
            recentBest = { at: row.focusedAt, sessionId };
    }
    return { current: (focusedBest ?? recentBest)?.sessionId, visible };
}

/**
 * Which Session each Desktop window is looking at right now. It replaces the old single "selected Session" cell, which
 * could not say what two windows see at once.
 *
 * - **Visible**: the union of the viewed Session over every visible window. Work that serves a human looking at the
 *   screen (file watching, status polling, Terminal suspension) keys off this set.
 * - **Current**: the focused window's Session, else the most recently focused window's. Anything that asks "which Session
 *   is the user in" (the CLI `current` selector, extension context, mobile panel checks) keys off this one.
 *
 * Rows are keyed `(connectionId, windowKey)` because one Desktop Main shares a single lease and connection across all
 * its windows, so a window is a level below the connection. Presence is memory only and cheap by construction: a report
 * is a map write plus one pass over a handful of rows. Nothing is persisted; a restarted Server starts with no
 * presence, so nothing is visible until Main reseeds it, which parks background Terminals instead of holding them open
 * on the strength of a window that may be gone.
 */
export class WindowPresence {
    private readonly rows = new Map<string, Map<string, PresenceRow>>();
    private readonly visibleListeners = new Set<Listener>();
    private readonly currentListeners = new Set<Listener>();
    private visible: ReadonlySet<string> = EMPTY;
    private current: string | undefined;
    /**
     * Until this time, an empty presence means "not reported yet" rather than "confirmed no visible window". Any report
     * or seed ends the wait; losing every connection that had rows starts it again.
     */
    private unsettledUntil: number;

    constructor(private readonly now: () => number = Date.now) {
        this.unsettledUntil = now() + PRESENCE_SEED_GRACE_MS;
    }

    /**
     * Recomputes the two derived values and notifies only on a real change, so a focus flip between two windows that
     * view the same Session wakes no consumer.
     */
    private settle(): void {
        const { current, visible } = deriveViews(this.rows);
        const isVisibleChanged =
            visible.size !== this.visible.size ||
            [...visible].some((sessionId) => !this.visible.has(sessionId));
        if (isVisibleChanged) this.visible = visible.size === 0 ? EMPTY : visible;
        const isCurrentChanged = current !== this.current;
        this.current = current;
        if (isVisibleChanged) notifyListeners(this.visibleListeners, undefined);
        if (isCurrentChanged) notifyListeners(this.currentListeners, undefined);
    }

    /**
     * Whether the Server may trust the visible set enough to act on its absences (suspending a Terminal because no
     * window shows its Session). False in the gap between a Server start or Desktop connection loss and the first
     * report, so the gap is not mistaken for every window being hidden.
     */
    isSettled(): boolean {
        return this.rows.size > 0 || this.now() >= this.unsettledUntil;
    }

    /**
     * Upserts one window's state. A window gaining focus is stamped so recency can pick it later.
     */
    report(connectionId: string, report: WindowPresenceReport): void {
        const windows = this.rows.get(connectionId) ?? new Map<string, PresenceRow>();
        this.rows.set(connectionId, windows);
        this.unsettledUntil = 0;
        const previous = windows.get(report.windowKey);
        const gainedFocus = report.focused && !previous?.focused;
        windows.set(report.windowKey, {
            focused: report.focused,
            focusedAt: gainedFocus ? this.now() : (previous?.focusedAt ?? 0),
            viewingSessionId: report.viewingSessionId,
            visible: report.visible,
        });
        this.settle();
    }

    /**
     * Replaces every row of the connection in one step with Main's snapshot, so the visible set and the current Session
     * change once, from the old state straight to the full new one.
     */
    seed(connectionId: string, seed: WindowPresenceSeed['windows']): void {
        this.unsettledUntil = 0;
        if (seed.length === 0) this.rows.delete(connectionId);
        else
            this.rows.set(
                connectionId,
                new Map(
                    seed.map((window) => [
                        window.windowKey,
                        {
                            focused: window.focused,
                            focusedAt: window.focusedAt,
                            viewingSessionId: window.viewingSessionId,
                            visible: window.visible,
                        },
                    ]),
                ),
            );
        this.settle();
    }

    /**
     * Records that a window just navigated, without waiting for its next full report. Applies only to a window that
     * already reported: a window the Server has never heard from stays invisible rather than being guessed into
     * visibility. Closes the gap in which a freshly selected Session still looks unwatched to the suspension fences.
     * Window keys are random per window, so the lookup spans connections: a Session archived over a CLI connection
     * still moves the Desktop window that showed it.
     */
    noteViewing(windowKey: string, sessionId: string | null): void {
        let isChanged = false;
        for (const windows of this.rows.values()) {
            const row = windows.get(windowKey);
            if (!row || row.viewingSessionId === sessionId) continue;
            row.viewingSessionId = sessionId;
            isChanged = true;
        }
        if (isChanged) this.settle();
    }

    close(connectionId: string, windowKey: string): void {
        const windows = this.rows.get(connectionId);
        if (!windows?.delete(windowKey)) return;
        if (windows.size === 0) this.rows.delete(connectionId);
        this.settle();
    }

    /**
     * Forgets every window of a connection that closed or was replaced.
     */
    dropConnection(connectionId: string): void {
        if (!this.rows.delete(connectionId)) return;
        if (this.rows.size === 0) this.unsettledUntil = this.now() + PRESENCE_SEED_GRACE_MS;
        this.settle();
    }

    visibleSessionIds(): ReadonlySet<string> {
        return this.visible;
    }

    /**
     * The one visible Session the single-scope file watcher follows: the current Session when it is visible, else any
     * visible one. With one window that is simply its Session; tear-off windows will need a watcher per Session.
     */
    primaryVisibleSessionId(): string | undefined {
        return this.current !== undefined && this.visible.has(this.current)
            ? this.current
            : this.visible.values().next().value;
    }

    currentSessionId(): string | undefined {
        return this.current;
    }

    /**
     * Fires when the visible set gains or loses a Session. The listener reads {@link visibleSessionIds}.
     */
    onVisibleChange(listener: Listener): () => void {
        this.visibleListeners.add(listener);
        return () => this.visibleListeners.delete(listener);
    }

    /**
     * Fires when {@link currentSessionId} changes.
     */
    onCurrentChange(listener: Listener): () => void {
        this.currentListeners.add(listener);
        return () => this.currentListeners.delete(listener);
    }
}
