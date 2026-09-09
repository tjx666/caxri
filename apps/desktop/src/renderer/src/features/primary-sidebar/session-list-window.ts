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
}

/**
 * Resolves the Sessions a Project renders. `revealedCount` is the count the user has revealed so far (`undefined` until
 * they ask for more).
 *
 * The selected Session is always inside the window: sidebar position is independent from visits, so selecting an older
 * Session through the MRU switcher or history navigation does not pull it to the top. Without this the sidebar would
 * show no selected row at all, which reads as a lost Session rather than a collapsed list.
 */
export function sessionListWindow<TSession extends { id: string }>(
    sessions: readonly TSession[],
    revealedCount: number | undefined,
    selectedSessionId: string | undefined,
): SessionListWindow<TSession> {
    const revealed = Math.max(revealedCount ?? 0, DEFAULT_VISIBLE_SESSION_COUNT);
    const selectedIndex = selectedSessionId
        ? sessions.findIndex((session) => session.id === selectedSessionId)
        : -1;
    const visibleCount = Math.max(revealed, selectedIndex + 1);
    const hiddenCount = Math.max(sessions.length - visibleCount, 0);
    return {
        hiddenCount,
        nextRevealCount: Math.min(hiddenCount, SESSION_REVEAL_STEP),
        visibleSessions: sessions.slice(0, visibleCount),
    };
}

/**
 * Advances the revealed count by one step. Takes the count currently on screen rather than the stored revealed count so
 * the reveal row's promised number is what actually appears, even when the selected-Session guarantee already widened
 * the window past the stored value.
 */
export function nextRevealedSessionCount(visibleCount: number): number {
    return visibleCount + SESSION_REVEAL_STEP;
}
