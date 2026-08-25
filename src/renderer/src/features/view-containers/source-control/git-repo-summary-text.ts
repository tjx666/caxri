import type { GitPullRequestChanges } from '@shared/types';

/**
 * Readable twin of the repository header's `↑N ↓M` ahead/behind glyphs, so a screen reader announces the same
 * information the `title` tooltip shows sighted users instead of two bare arrow icons.
 */
export function describeAheadBehind(ahead: number, behind: number): string {
    return `${ahead} ahead, ${behind} behind`;
}

/**
 * Accessible-name twin of the repository header's `#42 Fix thing` Pull Request summary. The row's `title` tooltip
 * already carries the base/head branch detail; this stays a shorter sentence matching what the row visibly shows, so a
 * screen reader announces the same PR number and title instead of nothing.
 */
export function describePullRequestSummary(
    pullRequest: Pick<GitPullRequestChanges, 'number' | 'title'>,
): string {
    return `Pull request #${pullRequest.number}: ${pullRequest.title}`;
}
