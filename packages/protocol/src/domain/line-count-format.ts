const LINE_COUNT_SUFFIXES = ['k', 'm', 'b'] as const;

/**
 * Formats a changed-line count the way compact diff stats read (`684`, `1.9k`, `12.3k`, `123k`, `1.2m`): exact below a
 * thousand, then one decimal while the scaled figure is under 100 and whole units above it, so a `+N −M` pair stays
 * narrow enough for a tree row's trailing column. Callers that announce the count to assistive technology keep the
 * exact number there.
 *
 * Lives in the protocol package because Desktop and Mobile must render the same diff stats identically and it is the
 * one package both may import. Hand-rolled rather than `Intl.NumberFormat({ notation: 'compact' })`, which Hermes on
 * Android does not implement.
 */
export function formatLineCount(count: number): string {
    if (count < 1000) return String(count);
    let scaled = count;
    for (const suffix of LINE_COUNT_SUFFIXES) {
        scaled /= 1000;
        const rounded = scaled < 100 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
        if (suffix === 'b' || rounded < 1000) return `${rounded}${suffix}`;
    }
    return String(count);
}
