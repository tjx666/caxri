/**
 * Pure windowing math for the PrimarySidebar's per-Project Session list. A long-lived Project accumulates dozens of
 * Sessions, and rendering all of them buries every Project below it, so the sidebar shows the most recent few and asks
 * for an explicit reveal for the rest. Kept out of `ProjectGroup`/`PrimarySidebar` so the arithmetic is covered by fast
 * unit tests instead of an Electron E2E workflow (see the `unit-testing` skill).
 */

/**
 * Sessions each Project shows before the reveal row appears.
 */
export const DEFAULT_VISIBLE_SESSION_COUNT = 5;

/**
 * Sessions each activation of the reveal row adds to the window.
 */
export const SESSION_REVEAL_STEP = 10;

export interface SessionListWindow<TSession> {
    /**
     * Sessions the window currently hides; `0` when the Project is fully revealed.
     */
    hiddenCount: number;
    /**
     * Sessions the next reveal will add, i.e. the number the reveal row promises. Smaller than
     * {@link SESSION_REVEAL_STEP} on the final step.
     */
    nextRevealCount: number;
    visibleSessions: TSession[];
    /**
     * Length of the in-order prefix the window shows, excluding a selected Session pinned in from below it. This is
     * what a reveal steps from, so the reveal row adds exactly the Sessions it promised.
     */
    windowCount: number;
}

/**
 * Resolves the Sessions a Project renders. `revealedCount` is the count the user has revealed so far (`undefined` until
 * they ask for more).
 *
 * The selected Session always renders: sidebar position is independent from visits, so selecting an older Session
 * through the MRU switcher or history navigation does not pull it to the top. Without this the sidebar would show no
 * selected row at all, which reads as a lost Session rather than a collapsed list.
 *
 * It is pinned to the end of the window rather than opened up to, because the guarantee is about that one row. Widening
 * the window to its index revealed every Session above it as well, which retired `Show N more`, pushed every Project
 * below off the screen, and turned one selection into a layout the user never asked for.
 */
export function sessionListWindow<TSession extends { id: string }>(
    sessions: readonly TSession[],
    revealedCount: number | undefined,
    selectedSessionId: string | undefined,
): SessionListWindow<TSession> {
    const windowCount = Math.min(
        Math.max(revealedCount ?? 0, DEFAULT_VISIBLE_SESSION_COUNT),
        sessions.length,
    );
    const visibleSessions = sessions.slice(0, windowCount);
    const selectedIndex = selectedSessionId
        ? sessions.findIndex((session) => session.id === selectedSessionId)
        : -1;
    const pinnedSelected = selectedIndex >= windowCount ? sessions[selectedIndex] : undefined;
    if (pinnedSelected) visibleSessions.push(pinnedSelected);
    /**
     * The promise is measured against the rows that will actually appear, not against one reveal step: a pinned
     * selected Session is already on screen, so the next step absorbs it instead of adding it again.
     */
    const nextWindowCount = Math.min(windowCount + SESSION_REVEAL_STEP, sessions.length);
    const nextVisibleCount = nextWindowCount + (selectedIndex >= nextWindowCount ? 1 : 0);
    return {
        hiddenCount: sessions.length - visibleSessions.length,
        nextRevealCount: nextVisibleCount - visibleSessions.length,
        visibleSessions,
        windowCount,
    };
}

/**
 * Advances the revealed count by one step. Takes {@link SessionListWindow.windowCount} rather than the stored revealed
 * count, so a window already clamped to a short Session list steps from what is on screen.
 */
export function nextRevealedSessionCount(windowCount: number): number {
    return windowCount + SESSION_REVEAL_STEP;
}

/**
 * The revealed count that brings the Session at `index` into the in-order window, or `undefined` when it is already
 * inside. Used when a newly pinned Session lands below the Pinned group's window: the user just asked to keep it in
 * sight, so the window opens down to it rather than hiding it behind `Show N more`.
 */
export function revealedCountIncluding(index: number, windowCount: number): number | undefined {
    return index >= windowCount ? index + 1 : undefined;
}
