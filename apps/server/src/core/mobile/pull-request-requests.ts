import type {
    MobilePullRequest,
    Principal,
    ProjectStatusRepository,
    ServerRequest,
} from '@caxri/protocol';
import {
    CaxriError,
    failedPullRequestCheckNames,
    MOBILE_PULL_REQUEST_FAILED_CHECK_NAMES,
} from '@caxri/protocol';

import type { ServerDomainService } from '../domain-service';
import { sessionForPrincipal } from './session-management';

type PullRequestRead = Extract<ServerRequest, { method: 'mobile.pullRequest.read' }>;
type PullRequestMerge = Extract<ServerRequest, { method: 'mobile.pullRequest.merge' }>;

/**
 * The repository whose pull request the phone shows: the primary repository's when it has one, otherwise the first
 * repository that does (a Session's Agent can deliver from a worktree or a nested repository).
 */
function deliveringRepo(
    repositories: readonly ProjectStatusRepository[],
): ProjectStatusRepository | undefined {
    return (
        repositories.find((repo) => repo.kind === 'primary' && repo.pullRequest) ??
        repositories.find((repo) => repo.pullRequest)
    );
}

export function projectMobilePullRequest(
    repositories: readonly ProjectStatusRepository[],
): MobilePullRequest | undefined {
    const repo = deliveringRepo(repositories);
    const pullRequest = repo?.pullRequest;
    if (!repo || !pullRequest) return undefined;
    const failed = failedPullRequestCheckNames(pullRequest);
    return {
        repositoryId: repo.id,
        number: pullRequest.number,
        title: pullRequest.title,
        url: pullRequest.url,
        ...(pullRequest.lifecycle && { lifecycle: pullRequest.lifecycle }),
        checks: pullRequest.state,
        checkCount: pullRequest.checks.length,
        failedChecks: failed.slice(0, MOBILE_PULL_REQUEST_FAILED_CHECK_NAMES),
        failedCheckCount: failed.length,
        ...(pullRequest.headSha && { headSha: pullRequest.headSha }),
        ...(pullRequest.mergeBlocker && { mergeBlocker: pullRequest.mergeBlocker }),
    };
}

/**
 * Reads the Session's pull request from the same Project Status summary the Desktop Status panel shows, after admitting
 * the Session for this device.
 */
export async function readMobilePullRequest(
    domainService: ServerDomainService,
    principal: Principal,
    request: PullRequestRead,
): Promise<{ pullRequest?: MobilePullRequest }> {
    const { sessionId } = request.params;
    await sessionForPrincipal(domainService, principal, sessionId);
    const summary = await domainService.request('projectStatus.summary', { sessionId });
    const pullRequest = projectMobilePullRequest(summary.repositories);
    return pullRequest ? { pullRequest } : {};
}

/**
 * Merges through Desktop's own `git.mergePullRequest`, so the merge method choice, the `--match-head-commit` pin, and
 * the cache invalidation that refreshes every surface stay one implementation. A conflict is refused here as well as on
 * the phone, because GitHub would refuse it anyway and the phone may hold a stale sheet.
 */
export async function mergeMobilePullRequest(
    domainService: ServerDomainService,
    principal: Principal,
    request: PullRequestMerge,
    signal: AbortSignal,
): Promise<{ method: 'merge' | 'rebase' | 'squash' }> {
    const { sessionId, repositoryId, number, headSha } = request.params;
    await sessionForPrincipal(domainService, principal, sessionId);
    const summary = await domainService.request('projectStatus.summary', { sessionId });
    const pullRequest = summary.repositories.find((repo) => repo.id === repositoryId)?.pullRequest;
    if (pullRequest?.number !== number)
        throw new CaxriError('NOT_FOUND', 'Pull request not found for this Session');
    if (pullRequest.mergeBlocker === 'conflicting')
        throw new CaxriError('CONFLICT', 'This pull request has conflicts');
    const { method } = await domainService.requestWithSignal(
        'git.mergePullRequest',
        { sessionId, repositoryId, number, headSha },
        signal,
    );
    return { method };
}
