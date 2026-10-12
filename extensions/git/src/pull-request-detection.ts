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

/**
 * Whether Source Control may move a Working Tree scope to Pull Request mode on its own. Uncommitted changes are what
 * Working Tree mode exists to show, so the panel never trades them for the pull request's diff behind the user's back.
 */
export function canAutoSelectPullRequestMode(
    repositories: ReadonlyArray<Pick<GitRepositorySummary, 'changedFileCount'>>,
): boolean {
    return repositories.every((repo) => repo.changedFileCount === 0);
}

/**
 * Runs the automatic Working Tree to Pull Request mode pick for one snapshot: while the scope's mode is unsettled and
 * the tree is clean, it starts each repository's pull request lookup through `loadPullRequest` and answers whether a
 * settled lookup already found one. A settled mode or a dirty tree starts no lookup at all.
 */
export function shouldAutoSelectPullRequestMode<
    Repo extends Pick<GitRepositorySummary, 'branch' | 'changedFileCount' | 'id'>,
>(
    scope: {
        isModeChosen: boolean;
        mode: string;
        pullRequests: ReadonlyMap<string, { value?: GitPullRequestChanges | null }>;
    },
    repositories: readonly Repo[],
    loadPullRequest: (repo: Repo) => void,
): boolean {
    if (scope.isModeChosen || scope.mode !== 'working') return false;
    if (!canAutoSelectPullRequestMode(repositories)) return false;
    for (const repo of repositories) if (canDetectPullRequest(repo)) loadPullRequest(repo);
    return hasDetectedPullRequest(repositories, scope.pullRequests);
}
