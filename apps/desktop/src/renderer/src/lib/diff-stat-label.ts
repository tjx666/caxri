/**
 * A `+N -M` changed-line pair in words, for accessible names and descriptions where bare signed digits would read as
 * arithmetic. Always the exact counts, never the compact display form.
 */
export function diffStatLabel(stat: { additions: number; deletions: number }): string {
    return `${stat.additions} ${stat.additions === 1 ? 'line' : 'lines'} added, ${stat.deletions} removed`;
}

/**
 * Which halves of a displayed `+N -M` pair carry information. A zero half beside a non-zero one is noise (`+3 -0`), so
 * it is dropped the way GitHub and VS Code drop it. An all-zero pair (a binary or mode-only change) keeps `+0` so the
 * count column never goes blank on a row that does have a change.
 */
export function visibleDiffStatParts(stat: { additions: number; deletions: number }): {
    additions: boolean;
    deletions: boolean;
} {
    if (stat.additions === 0 && stat.deletions === 0) return { additions: true, deletions: false };
    return { additions: stat.additions > 0, deletions: stat.deletions > 0 };
}
