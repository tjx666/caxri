import type { FileSearchTerminationReason } from '@caxri/protocol';

export type ProjectSearchDisplayState =
    'empty' | 'error' | 'idle' | 'incomplete' | 'results' | 'searching';

interface ProjectSearchDisplayInput {
    active: boolean;
    settled: boolean;
    fetching: boolean;
    failed: boolean;
    matchCount: number | undefined;
    truncated: boolean | undefined;
    canceled: boolean | undefined;
}

/**
 * Keeps an incomplete Server result distinct from a definitive empty search. A large Project may exhaust a safety bound
 * before reaching a matching file, so rendering that state as "No results" would be a false answer.
 */
export function projectSearchDisplayState({
    active,
    settled,
    fetching,
    failed,
    matchCount,
    truncated,
    canceled,
}: ProjectSearchDisplayInput): ProjectSearchDisplayState {
    if (!active) return 'idle';
    if (!settled) return 'searching';
    if (failed) return 'error';
    if (matchCount === 0 && (truncated || canceled)) return 'incomplete';
    if (!fetching && matchCount === 0) return 'empty';
    return 'results';
}

export function projectSearchTerminationMessage(
    reason: FileSearchTerminationReason,
    scannedFiles: number,
    hasMatches: boolean,
): string | undefined {
    const partial = hasMatches ? ' Showing partial results.' : ' Narrow the search to try again.';
    switch (reason) {
        case 'completed':
            return;
        case 'canceled':
            return 'Search canceled.';
        case 'timeout':
            return `Search timed out after scanning ${scannedFiles.toLocaleString()} files.${partial}`;
        case 'file-limit':
            return `Search stopped after reaching the ${scannedFiles.toLocaleString()} file limit.${partial}`;
        case 'result-limit':
            return 'Search reached the result limit. Showing partial results.';
        case 'payload-limit':
            return 'Search reached the response size limit. Showing partial results.';
    }
}
