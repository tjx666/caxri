import type {
    ProjectStatusCheck,
    ProjectStatusRepository as ProjectStatusRepo,
    ProjectStatusState,
    PullRequestMergeState,
    SessionPullRequestState,
} from '@caxri/protocol';
import { isIgnoredCheck, pullRequestMergeBlocker } from '@caxri/protocol';
import { z } from 'zod';

import { parseExternalJson } from '../external-status';

/**
 * Wire shapes and projections for the two external CLIs Project Status itself reads: `gh` and `vc`. Kept beside
 * `./index.ts` rather than inside it so the service file stays about orchestration (cache lifetime, refresh
 * generations, and the resident poll) and this file stays about turning `gh` and `vc` output into protocol types. The
 * equivalent Linear and Acceptance wire shapes live in `external-status/parse.ts`: those two CLIs are resolved on
 * demand by `LinearIssueStore` and `AcceptanceStore`, which this domain only calls through `external-status`'s barrel,
 * never past it.
 */

const githubCheckSchema = z.object({
    __typename: z.string().optional(),
    completedAt: z.string().nullable().optional(),
    conclusion: z.string().nullable().optional(),
    context: z.string().optional(),
    detailsUrl: z.string().optional(),
    name: z.string().optional(),
    startedAt: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    status: z.string().nullable().optional(),
    targetUrl: z.string().optional(),
    workflowName: z.string().optional(),
});

export type GitHubCheck = z.infer<typeof githubCheckSchema>;

const githubPullRequestSchema = z.object({
    baseRefName: z.string().optional(),
    body: z.string().optional(),
    headRefName: z.string().optional(),
    headRefOid: z.string().optional(),
    isDraft: z.boolean().optional(),
    mergeable: z.string().optional(),
    mergeStateStatus: z.string().optional(),
    mergeCommit: z.object({ oid: z.string() }).nullish(),
    mergedAt: z.string().nullish(),
    state: z.string().optional(),
    number: z.number().int().positive().optional(),
    statusCheckRollup: z.array(githubCheckSchema).optional(),
    title: z.string().min(1).optional(),
    url: z.string().optional(),
});

/**
 * Git provenance Vercel copies onto a deployment built from a connected repository. A direct CLI upload carries none of
 * it, so every field stays optional and the deployment row falls back to its alias.
 *
 * @see https://vercel.com/docs/deployments/environments#system-environment-variables
 */
const vercelDeploymentMetaSchema = z.object({
    githubCommitAuthorLogin: z.string().optional(),
    githubCommitMessage: z.string().optional(),
    githubCommitOrg: z.string().optional(),
    githubCommitRepo: z.string().optional(),
    githubCommitSha: z.string().optional(),
});

const vercelDeploymentSchema = z.object({
    uid: z.string().optional(),
    created: z.number().optional(),
    inspectorUrl: z.string().nullable().optional(),
    meta: vercelDeploymentMetaSchema.optional(),
    name: z.string().optional(),
    readyState: z.string().optional(),
    state: z.string().optional(),
    target: z.enum(['production', 'preview', 'staging']).nullable().optional(),
    url: z.string().nullable().optional(),
});

export type VercelDeployment = z.infer<typeof vercelDeploymentSchema>;

const vercelDeploymentListSchema = z.union([
    z.array(vercelDeploymentSchema),
    z.object({ deployments: z.array(vercelDeploymentSchema).optional() }),
]);

const vercelTeamSchema = z.object({ slug: z.string().optional() });

export const vercelTeamListSchema = z.union([
    z.array(vercelTeamSchema),
    z.object({ teams: z.array(vercelTeamSchema).optional() }),
]);

const SUCCESS_RESULTS = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED', 'COMPLETED']);
const FAILURE_RESULTS = new Set([
    'FAILURE',
    'FAILED',
    'TIMED_OUT',
    'ACTION_REQUIRED',
    'STARTUP_FAILURE',
    'ERROR',
]);
/**
 * Actually executing. GitHub reports this as a `status`, never as a `conclusion`.
 */
const RUNNING_RESULTS = new Set(['IN_PROGRESS']);
/**
 * Accepted but not started. `PENDING` and `EXPECTED` are the commit-status API's equivalents of a queued check run: a
 * context that has been registered and has reported no result yet.
 */
const QUEUED_RESULTS = new Set(['QUEUED', 'WAITING', 'REQUESTED', 'PENDING', 'EXPECTED']);

export function checkState(check: GitHubCheck): ProjectStatusState {
    const status = (check.status ?? '').toUpperCase();
    const result = (check.conclusion ?? check.state ?? '').toUpperCase();
    if (RUNNING_RESULTS.has(status) || RUNNING_RESULTS.has(result)) return 'pending';
    if (QUEUED_RESULTS.has(status) || QUEUED_RESULTS.has(result)) return 'queued';
    if (FAILURE_RESULTS.has(result)) return 'failure';
    if (result === 'CANCELLED') return 'cancelled';
    if (SUCCESS_RESULTS.has(result)) return 'success';
    return 'neutral';
}

export function aggregateChecks(checks: ProjectStatusCheck[]): ProjectStatusState {
    if (checks.some((check) => check.state === 'failure')) return 'failure';
    if (checks.length === 0 || checks.some((check) => check.state === 'pending')) return 'pending';
    // Nothing is running yet, but the run is not over either. Rolled up as `queued` rather than `pending` so the
    // summary can say a run has not started, which is the difference between waiting on a runner and waiting on CI.
    if (checks.some((check) => check.state === 'queued')) return 'queued';
    /**
     * Cancellation is visible but non-blocking once another terminal check supplies the rollup outcome. Preserve it as
     * the parent state only when cancellation is the sole outcome, because that set did not prove any work passed.
     */
    if (checks.every((check) => check.state === 'cancelled')) return 'cancelled';
    return 'success';
}

function checkDuration(check: GitHubCheck): number | undefined {
    if (!check.startedAt || !check.completedAt) return undefined;
    const duration = Date.parse(check.completedAt) - Date.parse(check.startedAt);
    return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}

function checkCompletedAt(check: GitHubCheck): number | undefined {
    if (!check.completedAt) return undefined;
    const completedAt = Date.parse(check.completedAt);
    // GitHub reports `0001-01-01T00:00:00Z` for a check that has not completed yet.
    return Number.isFinite(completedAt) && completedAt > 0 ? completedAt : undefined;
}

function projectCheck(check: GitHubCheck): ProjectStatusCheck {
    return {
        name: check.workflowName
            ? `${check.workflowName} / ${check.name ?? check.context ?? '?'}`
            : (check.name ?? check.context ?? '?'),
        state: checkState(check),
        url: check.detailsUrl ?? check.targetUrl,
        durationMs: checkDuration(check),
        completedAt: checkCompletedAt(check),
    };
}

/**
 * Reading order for one pull request's checks: what went wrong first, then what is still moving, then what is settled.
 * A state missing from this list sorts to `-1` and jumps ahead of the failures, so every member of
 * `projectStatusStateSchema` has to appear here, including `unknown`, which is what an unrecognized provider result
 * becomes.
 */
const CHECK_ORDER: ProjectStatusState[] = [
    'failure',
    'pending',
    'queued',
    'cancelled',
    'success',
    'neutral',
    'unknown',
];

/**
 * Both PR surfaces use the same lifecycle projection; a closed draft is closed, not draft.
 */
function pullRequestLifecycle(
    state: string | undefined,
    isDraft: boolean | undefined,
): SessionPullRequestState | undefined {
    switch (state?.toUpperCase()) {
        case 'MERGED':
            return 'merged';
        case 'CLOSED':
            return 'closed';
        case 'OPEN':
            return isDraft ? 'draft' : 'open';
        default:
            return undefined;
    }
}

/**
 * Reduces GitHub's two mergeability fields to one state. `mergeable: CONFLICTING` wins because it is the only one of
 * the two that GitHub settles before `mergeStateStatus` does; `HAS_HOOKS` merges like `CLEAN` once the hooks pass, and
 * `DRAFT` is already carried by the lifecycle.
 *
 * @see https://docs.github.com/en/graphql/reference/enums#mergestatestatus
 */
function pullRequestMergeState(
    mergeable: string | undefined,
    mergeStateStatus: string | undefined,
): PullRequestMergeState | undefined {
    if (mergeable === undefined && mergeStateStatus === undefined) return undefined;
    if (mergeable?.toUpperCase() === 'CONFLICTING') return 'conflicting';
    switch (mergeStateStatus?.toUpperCase()) {
        case 'CLEAN':
        case 'HAS_HOOKS':
            return 'clean';
        case 'UNSTABLE':
            return 'unstable';
        case 'BLOCKED':
            return 'blocked';
        case 'BEHIND':
            return 'behind';
        case 'DIRTY':
            return 'conflicting';
        default:
            return 'unknown';
    }
}

function mergedAtMilliseconds(value: string | null | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Projects one `gh pr view` payload. `ignoredChecks` is applied here rather than at each consumer so the Status panel's
 * rollup, the PrimarySidebar's CI badge, and the delivery-failure alert can never disagree about whether a pull request
 * is failing: they all read this one filtered result.
 */
export function parseGitHubPullRequest(
    value: string,
    ignoredChecks: readonly string[] = [],
): {
    body: string;
    pullRequest?: ProjectStatusRepo['pullRequest'];
    mergeCommit?: string;
    /**
     * When GitHub merged the pull request, in epoch milliseconds; absent while unmerged or when the timestamp is
     * unparsable.
     */
    mergedAt?: number;
} {
    const raw = parseExternalJson(value, githubPullRequestSchema, 'GitHub pull request');
    if (!raw.number || !raw.title || !raw.url) return { body: raw.body ?? '' };
    const rollup = raw.statusCheckRollup ?? [];
    const visible = rollup.filter(
        (check) => !isIgnoredCheck([check.name, check.context, check.workflowName], ignoredChecks),
    );
    const checks = visible.map((check) => projectCheck(check));
    checks.sort((a, b) => CHECK_ORDER.indexOf(a.state) - CHECK_ORDER.indexOf(b.state));
    const mergeState = pullRequestMergeState(raw.mergeable, raw.mergeStateStatus);
    const lifecycle = pullRequestLifecycle(raw.state, raw.isDraft);
    const state =
        checks.length === 0 &&
        (lifecycle === 'merged' || lifecycle === 'closed' || rollup.length > 0)
            ? 'neutral'
            : aggregateChecks(checks);
    const mergeBlocker = pullRequestMergeBlocker({ mergeState, state });
    return {
        body: raw.body ?? '',
        mergeCommit:
            raw.state?.toUpperCase() === 'MERGED' &&
            /^[\da-f]{40}$/i.test(raw.mergeCommit?.oid ?? '')
                ? raw.mergeCommit?.oid
                : undefined,
        ...(mergedAtMilliseconds(raw.mergedAt) !== undefined && {
            mergedAt: mergedAtMilliseconds(raw.mergedAt),
        }),
        pullRequest: {
            number: raw.number,
            title: raw.title,
            url: raw.url,
            lifecycle,
            /**
             * An empty rollup on an open pull request means GitHub has not reported a check yet, which is genuinely
             * pending. Two empty cases settle as neutral instead of a permanent spinner: a rollup that is empty only
             * _after_ filtering (the user ignored every check), and a merged or closed pull request, which will never
             * receive a check. The latter matters beyond the badge: a pending state keeps the Session on the 20s cache
             * TTL and holds the delivery watch on its 60s cadence, which production logs showed running all day for one
             * merged pull request in a repository without CI.
             */
            state,
            checks,
            hiddenCheckCount: rollup.length - visible.length,
            ...(raw.headRefOid &&
                /^[\da-f]{40}$/.test(raw.headRefOid) && { headSha: raw.headRefOid }),
            ...(raw.headRefName && { headBranch: raw.headRefName }),
            ...(raw.baseRefName && { baseBranch: raw.baseRefName }),
            ...(mergeState && { mergeState }),
            ...(mergeBlocker && { mergeBlocker }),
        },
    };
}

export function parseVercelList(value: string): VercelDeployment[] {
    const parsed = parseExternalJson(value, vercelDeploymentListSchema, 'Vercel deployment list');
    const deployments = Array.isArray(parsed) ? parsed : (parsed.deployments ?? []);
    return deployments.toSorted((a, b) => (b.created ?? 0) - (a.created ?? 0));
}
