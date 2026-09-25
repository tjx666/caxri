import type { ProjectStatusState, SessionPullRequest } from '@caxri/protocol';

import { parseGitHubPullRequest } from './project-status-parse';

/**
 * Pure projections from GitHub CLI output to the sidebar's per-Session pull-request row.
 */

function projectedChecks(
    checks: ReadonlyArray<{ state: ProjectStatusState }> | undefined,
    aggregate: ProjectStatusState | undefined,
): ProjectStatusState | undefined {
    return checks && checks.length > 0 ? aggregate : undefined;
}

export function parseSessionPullRequest(
    output: string,
    source: SessionPullRequest['source'],
    ignoredChecks: readonly string[],
): SessionPullRequest | undefined {
    const parsed = parseGitHubPullRequest(output, ignoredChecks).pullRequest;
    if (!parsed) return undefined;
    const state = parsed.lifecycle;
    if (!state) return undefined;
    return {
        number: parsed.number,
        title: parsed.title,
        url: parsed.url,
        state,
        checks: projectedChecks(parsed.checks, parsed.state),
        source,
    };
}

/**
 * Picks the PR that best represents a branch when several exist: a live open PR outranks the merged one that already
 * landed, which outranks an abandoned closed one.
 */
export function selectBranchPullRequest<T extends { state: string; isDraft?: boolean }>(
    candidates: readonly T[],
): T | undefined {
    const rank = (candidate: T): number => {
        switch (candidate.state.toUpperCase()) {
            case 'OPEN':
                return 0;
            case 'MERGED':
                return 1;
            default:
                return 2;
        }
    };
    let best: T | undefined;
    for (const candidate of candidates) if (!best || rank(candidate) < rank(best)) best = candidate;
    return best;
}
