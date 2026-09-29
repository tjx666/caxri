/**
 * A `+N −M` changed-line pair in words, for accessible names and descriptions where bare signed digits would read as
 * arithmetic. Always the exact counts, never the compact display form.
 */
export function diffStatLabel(stat: { additions: number; deletions: number }): string {
    return `${stat.additions} ${stat.additions === 1 ? 'line' : 'lines'} added, ${stat.deletions} removed`;
}
