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

/**
 * Identity of a Session's local inputs to the external refresh.
 *
 * `projectStatus.ignoredChecks` is an input to the rollup rather than a display filter, so a summary computed under
 * superseded rules is wrong the moment the user edits them. Folding the rules into the fingerprint reuses the cache's
 * existing "the inputs changed" path instead of adding a second invalidation mechanism, and the shared pull-request
 * store answers the re-parse from its own record, so the correction normally costs no extra GitHub query.
 */
export function preparedFingerprint(
    ignoredChecks: readonly string[],
    repositories: readonly PreparedRepo[],
): string {
    return JSON.stringify([
        ignoredChecks,
        repositories.map(({ context, repository }) => [
            repository.id,
            context.branch,
            context.defaultBranch,
            context.head,
            context.owner,
            context.repo,
            context.hasOrigin,
            context.detached,
            context.trackingHead,
        ]),
    ]);
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
