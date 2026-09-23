import type { ProjectStatusRepository, ProjectStatusSummary } from '@caxri/protocol';

import type { BranchPublicationContext } from './project-status-branch';

/**
 * Seeds a new fingerprint's cache entry with the delivery status the previous one already knew, so it is served
 * stale-while-revalidate instead of dropping back to a local-only summary.
 *
 * Only the selected Session is watched and polled, so an Agent committing or pushing in a background Session moves its
 * HEAD without touching the cache. Returning to that Session changed the fingerprint, which used to discard the whole
 * cached value: the Status panel reverted to "Checking origin…" with no pull request or deployments until the
 * background refresh landed seconds later. A repository keeps its old delivery fields only while it is still the same
 * GitHub branch — a different branch, remote, or a detached HEAD owns different delivery status, so it starts local.
 */
export function carryOverDelivery(
    prepared: ReadonlyArray<{
        context: BranchPublicationContext;
        repository: ProjectStatusRepository;
    }>,
    local: ProjectStatusSummary,
    previous: ProjectStatusSummary | undefined,
): ProjectStatusSummary | undefined {
    if (!previous) return undefined;
    const repositories = prepared.map(({ context, repository }) => {
        const known = previous.repositories.find(
            (candidate) =>
                candidate.id === repository.id &&
                candidate.branch === repository.branch &&
                candidate.githubUrl === repository.githubUrl,
        );
        if (!known || !repository.githubUrl || context.detached) return repository;
        return {
            ...repository,
            publication: known.publication,
            branchUrl: known.branchUrl,
            pullRequest: known.pullRequest,
            linearIssues: known.linearIssues,
            acceptances: known.acceptances,
            deployments: known.deployments,
            errors: known.errors,
        };
    });
    const isCarried = repositories.some((repo, index) => repo !== prepared[index]?.repository);
    return isCarried ? { ...local, repositories } : undefined;
}
