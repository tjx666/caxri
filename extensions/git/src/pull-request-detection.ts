import type { GitPullRequestChanges, GitRepositorySummary } from 'caxri';

import { DETACHED_BRANCH } from './repo-row-labels';

/**
 * Whether Source Control should look up a pull request for this repository while choosing its default mode. A detached
 * HEAD has no branch a pull request could track, so probing it only spends a `gh` call that fails and records an IPC
 * failure; CI release checkouts are detached.
 */
export function canDetectPullRequest(repo: Pick<GitRepositorySummary, 'branch'>): boolean {
    return repo.branch !== DETACHED_BRANCH;
}

/**
 * Whether any listed repository's branch has a pull request, as far as the settled lookups know. A repository whose
 * lookup is still loading or failed does not count, so the panel only switches on a pull request that was found.
 */
export function hasDetectedPullRequest(
    repositories: ReadonlyArray<Pick<GitRepositorySummary, 'id'>>,
    pullRequests: ReadonlyMap<string, { value?: GitPullRequestChanges | null }>,
): boolean {
    return repositories.some((repo) => Boolean(pullRequests.get(repo.id)?.value));
}
