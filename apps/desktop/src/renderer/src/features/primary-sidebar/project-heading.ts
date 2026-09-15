/**
 * Pure presentation copy for the PrimarySidebar's Project heading row. Kept out of `ProjectGroup` so the wording and
 * its pluralization are covered by fast unit tests instead of an Electron E2E workflow (see the `unit-testing` skill).
 */

/**
 * Accessible name for a Project heading. The heading renders its Session count as a decorative digit next to the title,
 * so the count has to be named here; otherwise assistive technology either loses it entirely or reads the title
 * followed by a bare number with nothing saying what was counted.
 */
export function describeProjectSessionCount(displayTitle: string, sessionCount: number): string {
    return `${displayTitle} (${sessionCount} ${sessionCount === 1 ? 'Session' : 'Sessions'})`;
}
