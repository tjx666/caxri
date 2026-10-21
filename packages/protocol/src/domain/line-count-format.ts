const LINE_COUNT_SUFFIXES = ['k', 'm', 'b'] as const;

/**
 * A compact count split into the scaled figure and its suffix (`12_345` is `{ value: 12.3, suffix: 'k' }`), for a
 * surface that animates the figure and draws the suffix beside it. {@link formatCompactCount} joins the two, so both
 * forms round the same way.
 */
export function compactCountParts(
    count: number,
    suffixes: readonly [string, string, string],
): { value: number; suffix: string } {
    if (count < 1000) return { value: count, suffix: '' };
    let scaled = count;
    for (const [index, suffix] of suffixes.entries()) {
        scaled /= 1000;
        const rounded = scaled < 100 ? Math.round(scaled * 10) / 10 : Math.round(scaled);
        if (index === suffixes.length - 1 || rounded < 1000) return { value: rounded, suffix };
    }
    return { value: count, suffix: '' };
}

/**
 * Exact below a thousand, then one decimal while the scaled figure is under 100 and whole units above it, rolling over
 * to the next suffix instead of printing `1000k`. Shared by every compact count so diff stats and token totals round
 * the same way.
 */
export function formatCompactCount(
    count: number,
    suffixes: readonly [string, string, string],
): string {
    const { value, suffix } = compactCountParts(count, suffixes);
    return `${value}${suffix}`;
}

/**
 * Formats a changed-line count the way compact diff stats read (`684`, `1.9k`, `12.3k`, `123k`, `1.2m`): exact below a
 * thousand, then one decimal while the scaled figure is under 100 and whole units above it, so a `+N -M` pair stays
 * narrow enough for a tree row's trailing column. Callers that announce the count to assistive technology keep the
 * exact number there.
 *
 * Lives in the protocol package because Desktop and Mobile must render the same diff stats identically and it is the
 * one package both may import. Hand-rolled rather than `Intl.NumberFormat({ notation: 'compact' })`, which Hermes on
 * Android does not implement.
 */
export function formatLineCount(count: number): string {
    return formatCompactCount(count, LINE_COUNT_SUFFIXES);
}

/**
 * Which halves of a displayed `+N -M` pair carry information. A zero half beside a non-zero one is noise (`+3 -0`), so
 * it is dropped the way GitHub and VS Code drop it. An all-zero pair (a binary or mode-only change) keeps `+0` so the
 * count column never goes blank on a row that does have a change. Shared so Desktop and Mobile drop the same half.
 */
export function visibleDiffStatParts(stat: { additions: number; deletions: number }): {
    additions: boolean;
    deletions: boolean;
} {
    if (stat.additions === 0 && stat.deletions === 0) return { additions: true, deletions: false };
    return { additions: stat.additions > 0, deletions: stat.deletions > 0 };
}
