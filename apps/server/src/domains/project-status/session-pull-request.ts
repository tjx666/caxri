import type {
    ProjectStatusOverview,
    PullRequestUnavailable,
    SessionPullRequest,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import { logEventCatalog } from '@caxri/system';

import type { GitHubPullRequestStore } from '../external-status';
import {
    isNoPullRequest,
    pullRequestUnavailable as describePullRequestUnavailable,
} from '../external-status';
import { parseGitHubPullRequest } from './parse';
import { pullRequestOrigin } from './session-pull-request-deployment';
import type { SessionPullRequestResolution } from './session-pull-request-parse';
import { projectedChecks } from './session-pull-request-parse';

/**
 * Reads the pull request a Session delivers from `SessionPullRequestService`, the one owner of that answer. The sidebar
 * row, the status bar, and the Status panel all follow it, so a pull request the Agent opened from another worktree or
 * a child repository no longer shows beside the Session name while the status bar reports none (issue #1304).
 */
export type SessionPullRequestResolver = (
    sessionId: string,
) => Promise<SessionPullRequestResolution | undefined>;

/**
 * Which pull request a Project Status reader loads.
 *
 * - `number`: the Session's own pull request, which may live in a repository other than the primary one.
 * - `branch`: no resolver answered, so the reader keeps its per-branch `gh pr view`.
 * - `none`: the Session has no pull request, or its last lookup failed; GitHub is not asked a second time.
 */
export type PullRequestTarget =
    | { kind: 'branch' }
    | { kind: 'none'; unavailable?: PullRequestUnavailable }
    | {
          kind: 'number';
          number: number;
          owner: string;
          repo: string;
          source: SessionPullRequest['source'];
      };

function sessionPullRequestTarget(
    resolution: SessionPullRequestResolution | undefined,
): PullRequestTarget {
    if (!resolution) return { kind: 'branch' };
    const reference = resolution.value ? pullRequestOrigin(resolution.value.url) : undefined;
    if (reference)
        return {
            kind: 'number',
            number: reference.number,
            owner: reference.owner,
            repo: reference.repo,
            source: resolution.value?.source ?? 'branch',
        };
    return { kind: 'none', ...(resolution.unavailable && { unavailable: resolution.unavailable }) };
}

/**
 * The Status panel renders one row per repository, and the Session's pull request replaces the branch lookup only for
 * the row of the repository it was opened against. Every other row keeps its own branch's pull request.
 */
export function repoPullRequestNumber(
    target: PullRequestTarget,
    context: { owner?: string; repo?: string },
): number | undefined {
    if (target.kind !== 'number') return undefined;
    return target.owner.toLowerCase() === context.owner?.toLowerCase() &&
        target.repo.toLowerCase() === context.repo?.toLowerCase()
        ? target.number
        : undefined;
}

/**
 * Which pull request this Session's readers load. A missing or failing resolver degrades to the per-branch lookup
 * rather than failing the status bar.
 */
export async function resolvePullRequestTarget(
    resolver: SessionPullRequestResolver | undefined,
    sessionId: string,
): Promise<PullRequestTarget> {
    try {
        return sessionPullRequestTarget(await resolver?.(sessionId));
    } catch {
        return { kind: 'branch' };
    }
}

type OverviewRepo = NonNullable<ProjectStatusOverview['repository']>;

/**
 * Loads the status bar's pull request chip. The shared pull-request record already carries `body` (see
 * `PULL_REQUEST_FIELDS` in `external-status/github.ts`), so the Linear and acceptance references the overview reads out
 * of it cost no extra GitHub query.
 */
export async function loadOverviewPullRequest(
    github: GitHubPullRequestStore,
    logger: StructuredLogger,
    {
        github: remote,
        ignoredChecks,
        repo,
        resolver,
        sessionId,
    }: {
        github: { owner: string; repo: string } | undefined;
        /**
         * `projectStatus.ignoredChecks`, so the chip's CI state is the one the sidebar row and Status panel derive.
         */
        ignoredChecks: readonly string[];
        repo: { branch: string; rootPath: string };
        /**
         * The Session's pull request resolver; the loader resolves the target itself.
         */
        resolver: SessionPullRequestResolver | undefined;
        sessionId: string;
    },
): Promise<
    Pick<OverviewRepo, 'pullRequest' | 'pullRequestUnavailable'> & {
        pullRequestBody?: string;
    }
> {
    const target = await resolvePullRequestTarget(resolver, sessionId);
    if (target.kind === 'none')
        return target.unavailable ? { pullRequestUnavailable: target.unavailable } : {};
    // A branch lookup needs the primary repository's own GitHub remote; the Session's pull request names its own.
    if (!remote && target.kind === 'branch') return {};
    try {
        /**
         * Share one PR record across the status bar's polls, the Status panel, and the sidebar row, which has normally
         * just fetched the Session's pull request by number.
         */
        const output = await github.view({
            allowStaleOnFailure: false,
            cwd: repo.rootPath,
            ...(target.kind === 'number'
                ? { number: target.number, owner: target.owner, repo: target.repo }
                : { branch: repo.branch, owner: remote?.owner ?? '', repo: remote?.repo ?? '' }),
        });
        const parsed = output ? parseGitHubPullRequest(output, ignoredChecks) : undefined;
        const parsedPullRequest = parsed?.pullRequest;
        const checks = projectedChecks(parsedPullRequest?.checks, parsedPullRequest?.state);
        return {
            pullRequestBody: parsed?.body,
            ...(parsedPullRequest && {
                pullRequest: {
                    number: parsedPullRequest.number,
                    title: parsedPullRequest.title,
                    url: parsedPullRequest.url,
                    ...(parsedPullRequest.headBranch && {
                        headBranch: parsedPullRequest.headBranch,
                    }),
                    // The sidebar suppresses checks outside an open pull request; the chip follows it.
                    ...(parsedPullRequest.lifecycle === 'open' && checks && { checks }),
                    source:
                        target.kind === 'number' && target.source === 'agent'
                            ? ('conversation' as const)
                            : ('branch' as const),
                },
            }),
        };
    } catch (error) {
        if (isNoPullRequest(error)) return {};
        const pullRequestUnavailable = describePullRequestUnavailable(error);
        logger.write('warn', logEventCatalog.projectStatus.overviewGithubUnavailable, {
            fields: { reason: pullRequestUnavailable.reason },
        });
        return { pullRequestUnavailable };
    }
}
