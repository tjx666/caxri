import type { ProjectStatusRepository, ProjectStatusSummary } from '@caxri/protocol';

import type { BranchPublicationContext } from './branch';

export interface PreparedRepo {
    context: BranchPublicationContext;
    repository: ProjectStatusRepository;
}

/**
 * A Session's local Git projection, ready for the external refresh. `fingerprint` is absent when there is nothing to
 * refresh.
 */
export interface PreparedSummary {
    fingerprint?: string;
    repositories: PreparedRepo[];
    summary: ProjectStatusSummary;
}

export interface SummaryCacheEntry {
    expiresAt: number;
    fingerprint: string;
    refreshToken?: string;
    value?: ProjectStatusSummary;
}

/**
 * The cache entry a Session holds while its refresh is in flight: the previous entry when the local inputs did not
 * change, otherwise an expired one carrying whatever delivery status still applies (see {@link carryOverDelivery}).
 */
export function pendingSummaryEntry(
    prepared: PreparedSummary,
    fingerprint: string,
    previous: SummaryCacheEntry | undefined,
    refreshToken?: string,
): SummaryCacheEntry {
    if (previous?.fingerprint === fingerprint) return previous;
    return {
        expiresAt: 0,
        fingerprint,
        refreshToken,
        value: carryOverDelivery(prepared.repositories, prepared.summary, previous?.value),
    };
}

/**
 * Seeds a new fingerprint's cache entry with the delivery status the previous one already knew, so it is served
 * stale-while-revalidate instead of dropping back to a local-only summary.
 *
 * Only the selected Session is file-watched and polled quickly (background Sessions get at most the slow delivery
 * watch), so an Agent committing or pushing in a background Session moves its HEAD without touching the cache.
 * Returning to that Session changed the fingerprint, which used to discard the whole cached value: the Status panel
 * reverted to "Checking origin…" with no pull request or deployments until the background refresh landed seconds later.
 * A repository keeps its old delivery fields only while it is still the same GitHub branch: a different branch, remote,
 * or a detached HEAD owns different delivery status, so it starts local.
 */
function carryOverDelivery(
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
