/**
 * A paired device's `Access:` line used to repeat the literal `Unavailable Project` once per grant the current window
 * cannot resolve: a device with several stale grants read as `Unavailable Project, Unavailable Project, …`, which is
 * also what stretched the Paired devices card past the Settings content column (no single word to truncate against).
 * Collapsing every unresolved grant into one trailing `+N unavailable` keeps the line honest (the device still has that
 * many grants) without repeating a word that carries no new information after the first time.
 */
export function summarizeProjectAccess(titles: ReadonlyArray<string | undefined>): string {
    const known = titles.filter((title): title is string => title !== undefined);
    const unavailableCount = titles.length - known.length;
    if (unavailableCount === 0) return known.join(', ');
    const suffix = `+${unavailableCount} unavailable`;
    return known.length > 0 ? `${known.join(', ')} · ${suffix}` : suffix;
}
